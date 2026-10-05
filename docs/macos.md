# macOS deployment

Install Node.js 24 or later and Python 3. Install dependencies with `npm ci`.
Run pairing manually before installing the LaunchAgent.
Use absolute paths. launchd does not load your interactive shell profile.

```sh
export WPP_DATA_DIR="$HOME/Library/Application Support/wpp-vip-ingest"
export WPP_GROUPS="123456789@g.us"
export WPP_OPERATORS="5511777777777@s.whatsapp.net"
npm run pair
bash deploy/install-launchagent.sh
```

The script writes `~/Library/LaunchAgents/com.aurea.wpp-vip-ingest.plist`.
Its label is `com.aurea.wpp-vip-ingest`.
Its data directory is `WPP_DATA_DIR` and its source is `WPP_SOURCE`, or `source.json` in that data directory.
Create the source with only `phone` and `group` fields.

Inspect service status:

```sh
launchctl print "gui/$(id -u)/com.aurea.wpp-vip-ingest"
```

Stop before a human check or retry:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aurea.wpp-vip-ingest.plist"
node src/cli.mjs status
node src/cli.mjs check JOB_ID
```

After review, start it again:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aurea.wpp-vip-ingest.plist"
```

The LaunchAgent starts at user login and restarts only after a nonzero exit.
It uses a 60-second restart throttle. Logout exits with code zero and requires manual pairing.
Existing uncertain and invitation-required jobs remain stopped after restart.

Logs are in the data directory. Rotate them as needed. They do not contain exported WhatsApp events.
The `status` command prints job phone numbers for the local operator. Do not publish that output.
Protect the data directory and backups. Do not commit credentials, source files, or databases.

The worker creates `worker.lock` in the data directory. A crash can leave this directory behind.
Stop launchd and check that no worker or review command is active before removing the stale lock.
Then bootstrap again. Do not remove the lock from a running worker.

If the Mac sleeps, the process cannot continue reliable network work. Confirm membership after interruptions.
Use macOS power settings suitable for the required availability. A user LaunchAgent is not a pre-login service.
These instructions and the generated plist were checked structurally on Linux.
launchctl, pairing, and macOS runtime behavior still need tests on your Mac.
