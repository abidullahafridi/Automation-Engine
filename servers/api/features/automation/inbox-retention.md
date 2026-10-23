# Inbox deduplication retention

AE-T-021.1 supports replay or redelivery for at most **30 days**. Each accepted inbox key is retained for **35 days** from receipt: the replay window plus a five-day recovery buffer. MongoDB's TTL index is set to the stored `expiresAt` timestamp, so a cleanup cycle cannot remove a key before that point.

The inbox stores only `eventId`, `workspaceId`, and timestamps—never a raw event payload. The globally unique `eventId` prevents an event accepted for one workspace from being reused in another workspace. A repeat delivery in the same workspace returns `duplicate`; an event ID that conflicts across workspaces is rejected and counted as a security signal.

Changing either duration requires updating `inboxRetentionPolicy`, this document, and TC-0214 together. This is a development policy for the supported v1 replay/redelivery behavior; broader legal/privacy retention review remains an AE-E07 production gate.
