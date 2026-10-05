# Architecture

The business supplies approved `phone` and `group` entries.
The source boundary establishes authorization. The service does not validate customer consent.
Operator authorization and bot admin rights are technical access checks.

JSON source or `/add` command -> admission queue -> one Baileys worker -> participant result -> membership confirmation.

SQLite stores jobs, attempts, command receipts, and explicit PN/LID mappings.
Each phone/group pair has one job. No consent fields are stored.
Mappings contain actual JIDs obtained from Baileys. Numeric LIDs are never converted to phone numbers.
Conflicting mappings stop the operation.

The worker claims a job before network access. A second runner cannot claim the same queued job.
The live runtime requires an exclusive local session lock before connection.
Only that worker performs interrupted-job recovery.
The local importer can submit new jobs while the worker is running. It does not own a Baileys session.

The worker never repeats stopped jobs. Human check and retry are separate CLI operations.
`retry` needs a review note and confirmed absent membership. It cannot reset invitation-required jobs.
This is an operational review, not a customer-consent validation.

No event-export pipeline, raw event logger, message history, or remote central server is included.
Baileys still needs connection, credential, and command events for its normal operation.
Credentials and Signal keys are preserved in a private local directory for the trial.

Production work still required: durable auth store, real-account response fixtures,
macOS execution tests, and account-compatibility verification.
