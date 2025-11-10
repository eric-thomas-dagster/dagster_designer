"""Email Sensor component for Dagster Designer."""

from typing import Optional
import os
import re
import email
from email.header import decode_header
from imapclient import IMAPClient
from dagster import (
    Component,
    Resolvable,
    Definitions,
    SensorDefinition,
    RunRequest,
    SkipReason,
    SensorEvaluationContext,
    ComponentLoadContext,
    DefaultSensorStatus,
)
from pydantic import BaseModel, Field


class EmailSensorComponent(Component, Resolvable, BaseModel):
    """Component that creates a Dagster sensor for monitoring email inboxes."""

    sensor_name: str = Field(description="Name of the sensor")
    imap_host: str = Field(description="IMAP server hostname")
    imap_port: int = Field(default=993, description="IMAP server port")
    email_user: str = Field(description="Email username")
    email_password: str = Field(description="Email password")
    mailbox: str = Field(default="INBOX", description="Mailbox/folder to monitor")
    subject_pattern: Optional[str] = Field(default="", description="Regex pattern to match email subjects")
    from_pattern: Optional[str] = Field(default="", description="Regex pattern to match sender addresses")
    job_name: str = Field(description="Name of the job to trigger")
    minimum_interval_seconds: int = Field(default=60, description="How often to check for new emails")
    mark_as_read: bool = Field(default=True, description="Mark processed emails as read")
    default_status: str = Field(default="RUNNING", description="Default status of the sensor")

    def build_defs(self, context: ComponentLoadContext) -> Definitions:
        """Build definitions for the email sensor."""

        imap_host = self.imap_host
        imap_port = self.imap_port
        email_user = self.email_user
        email_password = self.email_password
        mailbox = self.mailbox
        subject_pattern = self.subject_pattern
        from_pattern = self.from_pattern
        mark_as_read = self.mark_as_read

        def sensor_fn(sensor_context: SensorEvaluationContext):
            # Get credentials from environment or use provided values
            user = os.getenv("EMAIL_USER", email_user)
            password = os.getenv("EMAIL_PASSWORD", email_password)

            try:
                # Connect to IMAP server
                with IMAPClient(host=imap_host, port=imap_port, ssl=True) as mail:
                    mail.login(user, password)
                    mail.select_folder(mailbox)

                    # Search for unread messages
                    unread_messages = mail.search(['UNSEEN'])

                    if not unread_messages:
                        return SkipReason("No new unread emails found")

                    # Fetch message headers for filtering
                    messages = mail.fetch(unread_messages, ['BODY[HEADER.FIELDS (SUBJECT FROM DATE)]'])

                    # Filter by subject pattern if provided
                    if subject_pattern:
                        subject_regex = re.compile(subject_pattern)
                        unread_messages = [
                            uid for uid in unread_messages
                            if subject_regex.search(messages[uid][b'BODY[HEADER.FIELDS (SUBJECT FROM DATE)]'].decode('utf-8', errors='ignore'))
                        ]

                    # Filter by from address pattern if provided
                    if from_pattern:
                        from_regex = re.compile(from_pattern)
                        unread_messages = [
                            uid for uid in unread_messages
                            if from_regex.search(messages[uid][b'BODY[HEADER.FIELDS (SUBJECT FROM DATE)]'].decode('utf-8', errors='ignore'))
                        ]

                    if not unread_messages:
                        return SkipReason("No emails matching the filters")

                    # Create run requests for each matching email
                    for uid in unread_messages:
                        msg_data = messages[uid]
                        headers = msg_data[b'BODY[HEADER.FIELDS (SUBJECT FROM DATE)]'].decode('utf-8', errors='ignore')
                        email_msg = email.message_from_string(headers)

                        # Decode subject
                        subject = email_msg.get('Subject', '')
                        if subject:
                            decoded_parts = decode_header(subject)
                            subject = ''.join([
                                part.decode(encoding or 'utf-8', errors='ignore') if isinstance(part, bytes) else part
                                for part, encoding in decoded_parts
                            ])

                        from_addr = email_msg.get('From', '')
                        date_str = email_msg.get('Date', '')

                        yield RunRequest(
                            run_key=f"email-{uid}-{date_str}",
                            run_config={
                                "ops": {
                                    "config": {
                                        "email_uid": str(uid),
                                        "email_subject": subject,
                                        "email_from": from_addr,
                                        "email_date": date_str,
                                    }
                                }
                            },
                            tags={
                                "email_from": from_addr,
                                "email_subject": subject,
                                "source": "email_sensor",
                            }
                        )

                        # Mark message as read if requested
                        if mark_as_read:
                            mail.add_flags([uid], [b'\\Seen'])

                    sensor_context.log.info(f"Triggered {len(unread_messages)} runs for new emails")

            except Exception as e:
                sensor_context.log.error(f"Error connecting to email server: {e}")
                return SkipReason(f"Error: {e}")

        # Create the sensor
        sensor = SensorDefinition(
            name=self.sensor_name,
            evaluation_fn=sensor_fn,
            job_name=self.job_name,
            minimum_interval_seconds=self.minimum_interval_seconds,
            default_status=DefaultSensorStatus.RUNNING if self.default_status == "RUNNING" else DefaultSensorStatus.STOPPED,
        )

        return Definitions(sensors=[sensor])
