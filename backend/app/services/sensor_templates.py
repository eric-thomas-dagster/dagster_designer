"""Template generators for sensor components."""


def generate_s3_sensor(params: dict) -> str:
    """Generate S3 sensor code."""
    sensor_name = params.get("sensor_name", "my_s3_sensor")
    bucket_name = params.get("bucket_name")
    prefix = params.get("prefix", "")
    pattern = params.get("pattern", "")
    job_name = params.get("job_name")
    interval = params.get("minimum_interval_seconds", 30)
    aws_region = params.get("aws_region", "")
    since_key = params.get("since_key", "")

    region_arg = f', region_name="{aws_region}"' if aws_region else ''

    pattern_check = ""
    if pattern:
        pattern_check = f"""
    # Filter by regex pattern
    import re
    pattern = re.compile(r'{pattern}')
    new_objects = [obj for obj in new_objects if pattern.match(obj['Key'])]
"""

    since_key_check = ""
    if since_key:
        since_key_check = f"""
    # Only process objects after the since_key
    new_objects = [obj for obj in new_objects if obj['Key'] > '{since_key}']
"""

    return f'''"""
S3 Bucket Sensor - Monitors S3 bucket for new objects
"""
import boto3
from dagster import sensor, RunRequest, SkipReason, SensorEvaluationContext
from datetime import datetime

from .{job_name} import {job_name}


@sensor(
    name="{sensor_name}",
    job={job_name},
    minimum_interval_seconds={interval},
)
def {sensor_name}(context: SensorEvaluationContext):
    """
    Monitors S3 bucket '{bucket_name}' for new objects.

    Prefix: {prefix if prefix else "None (all objects)"}
    Pattern: {pattern if pattern else "None"}
    """
    # Initialize S3 client
    s3_client = boto3.client('s3'{region_arg})

    # Get the last processed key from cursor
    last_key = context.cursor or ""

    # List objects in bucket
    paginator = s3_client.get_paginator('list_objects_v2')
    pages = paginator.paginate(
        Bucket='{bucket_name}',
        Prefix='{prefix}',
        StartAfter=last_key
    )

    # Collect new objects
    new_objects = []
    for page in pages:
        if 'Contents' in page:
            new_objects.extend(page['Contents'])
{pattern_check}{since_key_check}

    if not new_objects:
        return SkipReason(f"No new objects found in s3://{bucket_name}/{prefix}")

    # Sort by key to process in order
    new_objects.sort(key=lambda x: x['Key'])

    # Update cursor to the last processed key
    latest_key = new_objects[-1]['Key']
    context.update_cursor(latest_key)

    # Create run requests for each new object
    for obj in new_objects:
        yield RunRequest(
            run_key=f"{{obj['Key']}}-{{obj['LastModified'].timestamp()}}",
            run_config={{
                "ops": {{
                    # Pass S3 object info to the job
                    "config": {{
                        "s3_bucket": "{bucket_name}",
                        "s3_key": obj['Key'],
                        "s3_size": obj['Size'],
                        "s3_last_modified": obj['LastModified'].isoformat(),
                    }}
                }}
            }},
            tags={{
                "s3_bucket": "{bucket_name}",
                "s3_key": obj['Key'],
                "source": "s3_sensor",
            }}
        )

    context.log.info(f"Triggered {{len(new_objects)}} runs for new S3 objects")
'''


def generate_email_sensor(params: dict) -> str:
    """Generate Email sensor code."""
    sensor_name = params.get("sensor_name", "my_email_sensor")
    imap_host = params.get("imap_host")
    imap_port = params.get("imap_port", 993)
    email_user = params.get("email_user")
    email_password = params.get("email_password")
    mailbox = params.get("mailbox", "INBOX")
    subject_pattern = params.get("subject_pattern", "")
    from_pattern = params.get("from_pattern", "")
    job_name = params.get("job_name")
    interval = params.get("minimum_interval_seconds", 60)
    mark_as_read = params.get("mark_as_read", True)

    subject_filter = ""
    if subject_pattern:
        subject_filter = f"""
    # Filter by subject pattern
    subject_regex = re.compile(r'{subject_pattern}')
    matching_messages = [uid for uid in unread_messages
                        if subject_regex.search(messages[uid][b'BODY[HEADER.FIELDS (SUBJECT)]'].decode('utf-8', errors='ignore'))]
    unread_messages = matching_messages
"""

    from_filter = ""
    if from_pattern:
        from_filter = f"""
    # Filter by from address pattern
    from_regex = re.compile(r'{from_pattern}')
    matching_messages = [uid for uid in unread_messages
                        if from_regex.search(messages[uid][b'BODY[HEADER.FIELDS (FROM)]'].decode('utf-8', errors='ignore'))]
    unread_messages = matching_messages
"""

    mark_read_code = ""
    if mark_as_read:
        mark_read_code = """
        # Mark message as read
        mail.add_flags([uid], [b'\\\\Seen'])
"""

    return f'''"""
Email Inbox Sensor - Monitors email inbox for new messages
"""
import os
import re
import email
from email.header import decode_header
from imapclient import IMAPClient
from dagster import sensor, RunRequest, SkipReason, SensorEvaluationContext

from .{job_name} import {job_name}


@sensor(
    name="{sensor_name}",
    job={job_name},
    minimum_interval_seconds={interval},
)
def {sensor_name}(context: SensorEvaluationContext):
    """
    Monitors email inbox for new messages.

    IMAP Host: {imap_host}
    Mailbox: {mailbox}
    """
    # Get credentials from environment or use provided values
    email_user = os.getenv("EMAIL_USER", "{email_user}")
    email_password = os.getenv("EMAIL_PASSWORD", "{email_password}")

    try:
        # Connect to IMAP server
        with IMAPClient(host='{imap_host}', port={imap_port}, ssl=True) as mail:
            mail.login(email_user, email_password)
            mail.select_folder('{mailbox}')

            # Search for unread messages
            unread_messages = mail.search(['UNSEEN'])

            if not unread_messages:
                return SkipReason("No new unread emails found")

            # Fetch message headers for filtering
            messages = mail.fetch(unread_messages, ['BODY[HEADER.FIELDS (SUBJECT FROM DATE)]'])
{subject_filter}{from_filter}
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
                    run_key=f"email-{{uid}}-{{date_str}}",
                    run_config={{
                        "ops": {{
                            "config": {{
                                "email_uid": str(uid),
                                "email_subject": subject,
                                "email_from": from_addr,
                                "email_date": date_str,
                            }}
                        }}
                    }},
                    tags={{
                        "email_from": from_addr,
                        "email_subject": subject,
                        "source": "email_sensor",
                    }}
                )
{mark_read_code}
            context.log.info(f"Triggered {{len(unread_messages)}} runs for new emails")

    except Exception as e:
        context.log.error(f"Error connecting to email server: {{e}}")
        return SkipReason(f"Error: {{e}}")
'''


def generate_filesystem_sensor(params: dict) -> str:
    """Generate File System sensor code."""
    sensor_name = params.get("sensor_name", "my_filesystem_sensor")
    directory_path = params.get("directory_path")
    file_pattern = params.get("file_pattern", "*")
    recursive = params.get("recursive", False)
    job_name = params.get("job_name")
    interval = params.get("minimum_interval_seconds", 30)
    move_after = params.get("move_after_processing", False)
    archive_dir = params.get("archive_directory", "")

    glob_pattern = f"{directory_path}/**/{file_pattern}" if recursive else f"{directory_path}/{file_pattern}"

    move_code = ""
    if move_after and archive_dir:
        move_code = f"""
    # Move processed files to archive
    import shutil
    archive_dir = Path('{archive_dir}')
    archive_dir.mkdir(parents=True, exist_ok=True)

    for file_path in new_files:
        dest = archive_dir / file_path.name
        shutil.move(str(file_path), str(dest))
        context.log.info(f"Moved {{file_path}} to {{dest}}")
"""

    return f'''"""
File System Sensor - Monitors directory for new files
"""
from pathlib import Path
from dagster import sensor, RunRequest, SkipReason, SensorEvaluationContext

from .{job_name} import {job_name}


@sensor(
    name="{sensor_name}",
    job={job_name},
    minimum_interval_seconds={interval},
)
def {sensor_name}(context: SensorEvaluationContext):
    """
    Monitors directory '{directory_path}' for new files.

    Pattern: {file_pattern}
    Recursive: {recursive}
    """
    # Get list of files matching pattern
    base_path = Path("{directory_path}")

    if not base_path.exists():
        return SkipReason(f"Directory {{base_path}} does not exist")

    # Find matching files
    files = list(base_path.glob("{file_pattern if not recursive else '**/' + file_pattern}"))
    files = [f for f in files if f.is_file()]

    if not files:
        return SkipReason(f"No files matching pattern '{file_pattern}' found")

    # Get last processed timestamp from cursor
    last_timestamp = float(context.cursor or "0")

    # Filter for new files
    new_files = [f for f in files if f.stat().st_mtime > last_timestamp]

    if not new_files:
        return SkipReason("No new files since last check")

    # Sort by modification time
    new_files.sort(key=lambda f: f.stat().st_mtime)

    # Update cursor to latest timestamp
    latest_timestamp = new_files[-1].stat().st_mtime
    context.update_cursor(str(latest_timestamp))

    # Create run requests
    for file_path in new_files:
        yield RunRequest(
            run_key=f"{{file_path.name}}-{{file_path.stat().st_mtime}}",
            run_config={{
                "ops": {{
                    "config": {{
                        "file_path": str(file_path),
                        "file_name": file_path.name,
                        "file_size": file_path.stat().st_size,
                        "modified_time": file_path.stat().st_mtime,
                    }}
                }}
            }},
            tags={{
                "file_name": file_path.name,
                "file_path": str(file_path),
                "source": "filesystem_sensor",
            }}
        )

    context.log.info(f"Triggered {{len(new_files)}} runs for new files")
{move_code}
'''


def generate_database_sensor(params: dict) -> str:
    """Generate Database sensor code."""
    sensor_name = params.get("sensor_name", "my_database_sensor")
    connection_string = params.get("connection_string")
    table_name = params.get("table_name")
    timestamp_column = params.get("timestamp_column")
    query_condition = params.get("query_condition", "")
    job_name = params.get("job_name")
    interval = params.get("minimum_interval_seconds", 60)
    batch_size = params.get("batch_size", 100)

    where_clause = f"AND {query_condition}" if query_condition else ""

    return f'''"""
Database Sensor - Monitors database table for new rows
"""
import os
from sqlalchemy import create_engine, text
from dagster import sensor, RunRequest, SkipReason, SensorEvaluationContext

from .{job_name} import {job_name}


@sensor(
    name="{sensor_name}",
    job={job_name},
    minimum_interval_seconds={interval},
)
def {sensor_name}(context: SensorEvaluationContext):
    """
    Monitors table '{table_name}' for new rows.

    Timestamp column: {timestamp_column}
    """
    # Get connection string from environment
    conn_string = os.getenv("DATABASE_URL", "{connection_string}")

    try:
        # Create database engine
        engine = create_engine(conn_string)

        # Get last processed timestamp from cursor
        last_timestamp = context.cursor or "1970-01-01 00:00:00"

        # Query for new rows
        query = text(f"""
            SELECT *
            FROM {table_name}
            WHERE {timestamp_column} > :last_timestamp
            {where_clause}
            ORDER BY {timestamp_column} ASC
            LIMIT {batch_size}
        """)

        with engine.connect() as conn:
            result = conn.execute(query, {{"last_timestamp": last_timestamp}})
            new_rows = result.fetchall()
            column_names = result.keys()

        if not new_rows:
            return SkipReason(f"No new rows in {{'{table_name}'}}")

        # Update cursor to latest timestamp
        latest_timestamp = str(new_rows[-1][column_names.index('{timestamp_column}')])
        context.update_cursor(latest_timestamp)

        # Create run requests for each new row
        for row in new_rows:
            row_dict = dict(zip(column_names, row))
            row_id = row_dict.get('id', row_dict.get('{timestamp_column}'))

            yield RunRequest(
                run_key=f"row-{{row_id}}-{{row_dict['{timestamp_column}']}}",
                run_config={{
                    "ops": {{
                        "config": {{
                            "row_data": {{k: str(v) for k, v in row_dict.items()}},
                            "table_name": "{table_name}",
                        }}
                    }}
                }},
                tags={{
                    "table": "{table_name}",
                    "row_id": str(row_id),
                    "source": "database_sensor",
                }}
            )

        context.log.info(f"Triggered {{len(new_rows)}} runs for new database rows")

    except Exception as e:
        context.log.error(f"Error querying database: {{e}}")
        return SkipReason(f"Database error: {{e}}")
'''


def generate_webhook_sensor(params: dict) -> str:
    """Generate Webhook sensor code."""
    sensor_name = params.get("sensor_name", "my_webhook_sensor")
    webhook_path = params.get("webhook_path")
    job_name = params.get("job_name")
    auth_token = params.get("auth_token", "")
    validate_signature = params.get("validate_signature", False)
    signature_header = params.get("signature_header", "X-Hub-Signature-256")
    secret_key = params.get("secret_key", "")

    return f'''"""
Webhook Sensor - Listens for HTTP webhook callbacks
"""
import os
import hmac
import hashlib
from flask import Flask, request, jsonify
from dagster import sensor, RunRequest, SkipReason, SensorEvaluationContext

from .{job_name} import {job_name}


# Note: Webhook sensors require a web server to receive HTTP requests.
# This is a simplified example. In production, you would use a proper
# webhook framework like dagster-cloud webhooks or run your own server.

@sensor(
    name="{sensor_name}",
    job={job_name},
)
def {sensor_name}(context: SensorEvaluationContext):
    """
    Webhook sensor for path '{webhook_path}'.

    Note: This sensor requires external webhook handling infrastructure.
    Consider using dagster-cloud webhooks or implementing a separate
    webhook receiver service that writes to a queue or database.
    """
    # This is a placeholder implementation
    # In practice, webhooks would be handled by:
    # 1. Dagster Cloud webhook sensors
    # 2. External service writing to a queue/database
    # 3. Custom webhook receiver storing events

    # Check for webhook events (e.g., from a queue or database)
    # For this example, we assume events are stored externally

    return SkipReason(
        "Webhook sensor requires external webhook handling. "
        "See documentation for setup instructions."
    )


# Example webhook receiver (run separately from Dagster)
def create_webhook_app():
    """
    Example Flask app to receive webhooks.
    Run this separately: python -m flask run
    """
    app = Flask(__name__)

    @app.route('{webhook_path}', methods=['POST'])
    def webhook_handler():
        # Validate auth token if provided
        auth_header = request.headers.get('Authorization', '')
        expected_token = os.getenv('WEBHOOK_TOKEN', '{auth_token}')
        if expected_token and auth_header != f'Bearer {{expected_token}}':
            return jsonify({{"error": "Unauthorized"}}), 401

        # Validate signature if enabled
        if {str(validate_signature).lower()}:
            signature = request.headers.get('{signature_header}', '')
            secret = os.getenv('WEBHOOK_SECRET', '{secret_key}')
            payload = request.get_data()
            expected_sig = 'sha256=' + hmac.new(
                secret.encode(),
                payload,
                hashlib.sha256
            ).hexdigest()

            if not hmac.compare_digest(signature, expected_sig):
                return jsonify({{"error": "Invalid signature"}}), 401

        # Store webhook event for sensor to process
        # (write to queue, database, etc.)
        event_data = request.json

        # TODO: Store event for sensor to pick up
        # Example: write to Redis, database, file, etc.

        return jsonify({{"status": "received"}}), 200

    return app


if __name__ == '__main__':
    app = create_webhook_app()
    app.run(host='0.0.0.0', port=5000)
'''
