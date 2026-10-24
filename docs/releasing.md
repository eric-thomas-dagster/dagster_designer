# How a change reaches the desktop app

You don't need to do anything beyond merging to `main`.

1. Push to `main` in this repo (`dagster_designer`).
2. Within about 15 minutes, a scheduled check in `dagster-designer-desktop` sees that `main` has commits no release was built from and starts a release. (Pushing to the desktop repo starts one immediately.)
3. The release builds the Mac, Windows and Linux installers from this repo's `main`, publishes them, and updates the update feed.
4. Installed apps are offered the new version when they launch, or from **Dagster Designer ▸ Check for Updates…**. The app asks before installing.

## Good to know

- **A broken build doesn't ship.** If the build fails nothing is published, and the check waits for a new commit instead of retrying the same one.
- **Every push to `main` ships.** There is no staging step, so use pull requests for anything risky.
- **Releases are numbered by workflow run** (`0.1.<run number>`), so numbers can skip.
- **To release right now,** run the *Release* workflow in `dagster-designer-desktop` from the Actions tab. Uncheck *Publish* to try a build without releasing it.
- **Where things live:** the release workflow (`release.yml`), the scheduled check (`auto-release.yml`) and the update-signing key (a repo secret) are all in `dagster-designer-desktop`.
