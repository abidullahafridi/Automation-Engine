import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidencePath = resolve(
  repositoryRoot,
  `docs/architecture/evidence/ae-t-000-3-mongodb-transactions-${runStamp}.json`
);
const transactionOptions = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary"
};
const checkNames = [
  "topology",
  "atomicCommit",
  "abortRollback",
  "duplicateKeyAbort",
  "concurrentNoLostUpdate"
];

class VerificationFailure extends Error {}

const productionMarker = /(?:^|[._-])(prod|production|live)(?:[._-]|$)/i;

function validateTargetUri(uri) {
  let target;

  try {
    target = new URL(uri);
  } catch {
    throw new VerificationFailure("MONGO_URI is not a valid MongoDB URI.");
  }

  if (!["mongodb:", "mongodb+srv:"].includes(target.protocol) || !target.hostname) {
    throw new VerificationFailure("MONGO_URI must use mongodb:// or mongodb+srv://.");
  }

  const databaseName = decodeURIComponent(target.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
  if (!databaseName) {
    throw new VerificationFailure("MONGO_URI must select a non-production database.");
  }

  if (productionMarker.test(target.hostname) || productionMarker.test(databaseName)) {
    throw new VerificationFailure("Production-like MongoDB targets are not allowed.");
  }
}

function safeFailure(error) {
  if (error instanceof VerificationFailure) {
    return { detail: error.message };
  }

  const name = error instanceof Error && /^[A-Za-z0-9_]+$/.test(error.name)
    ? error.name
    : "Error";
  const code = error && typeof error === "object" && Number.isInteger(error.code)
    ? error.code
    : undefined;

  return {
    detail: "MongoDB operation failed.",
    errorName: name,
    ...(code === undefined ? {} : { errorCode: code })
  };
}

async function runCheck(name, operation) {
  try {
    const details = await operation();
    return { name, status: "PASS", executed: true, ...details };
  } catch (error) {
    return { name, status: "FAIL", executed: true, ...safeFailure(error) };
  }
}

function notExecuted(name, detail) {
  return { name, status: "FAIL", executed: false, detail };
}

async function main() {
  const uri = process.env.MONGO_URI?.trim();
  if (!uri) {
    console.error("BLOCKED: Set MONGO_URI to a non-production MongoDB deployment; no connection was attempted.");
    process.exitCode = 2;
    return;
  }

  if (process.env.ALLOW_NON_PROD !== "yes") {
    console.error("BLOCKED: Set ALLOW_NON_PROD=yes to confirm the target is non-production; no connection was attempted.");
    process.exitCode = 2;
    return;
  }

  try {
    validateTargetUri(uri);
  } catch (error) {
    console.error(`BLOCKED: ${safeFailure(error).detail} No connection was attempted.`);
    process.exitCode = 2;
    return;
  }

  const requireFromApi = createRequire(new URL("../servers/api/package.json", import.meta.url));
  const mongoose = requireFromApi("mongoose");
  mongoose.set("debug", false);

  const evidence = {
    task: "AE-T-000.3",
    executedAt: new Date().toISOString(),
    operatorConfirmation: "ALLOW_NON_PROD=yes",
    checks: [],
    overall: "FAIL"
  };
  let database;
  let client;
  let collection;

  try {
    await mongoose.connect(uri, {
      appName: "ae-t-000-3-transaction-verification",
      connectTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 10_000
    });
    database = mongoose.connection.db;
    client = mongoose.connection.getClient();

    if (!database || !client) {
      throw new VerificationFailure("MongoDB connection did not expose a database and client.");
    }

    const collectionName = `ae_t0003_${randomUUID().replaceAll("-", "")}`;
    const runId = randomUUID();

    evidence.checks.push(await runCheck("topology", async () => {
      const hello = await database.admin().command({ hello: 1 });
      const replicaSet = typeof hello.setName === "string";
      const sharded = hello.msg === "isdbgrid";
      const sessionsSupported = Number.isFinite(hello.logicalSessionTimeoutMinutes);

      if ((!replicaSet && !sharded) || !sessionsSupported) {
        throw new VerificationFailure("Target does not advertise a transaction-capable replica set or sharded cluster.");
      }

      const buildInfo = await database.admin().command({ buildInfo: 1 });
      return {
        topology: replicaSet ? "replicaSet" : "sharded",
        sessionsSupported,
        serverVersion: typeof buildInfo.version === "string" ? buildInfo.version : "unknown"
      };
    }));

    await database.createCollection(collectionName);
    collection = database.collection(collectionName);

    evidence.checks.push(await runCheck("atomicCommit", async () => {
      const session = client.startSession();
      const firstId = `${runId}-commit-a`;
      const secondId = `${runId}-commit-b`;

      try {
        await session.withTransaction(async () => {
          await collection.insertMany(
            [{ _id: firstId, value: 1 }, { _id: secondId, value: 2 }],
            { session }
          );
        }, transactionOptions);
      } finally {
        await session.endSession();
      }

      const count = await collection.countDocuments({ _id: { $in: [firstId, secondId] } });
      if (count !== 2) {
        throw new VerificationFailure("Committed transaction did not persist both documents.");
      }

      return { committedDocuments: count };
    }));

    evidence.checks.push(await runCheck("abortRollback", async () => {
      const session = client.startSession();
      const firstId = `${runId}-abort-a`;
      const secondId = `${runId}-abort-b`;

      try {
        session.startTransaction(transactionOptions);
        await collection.insertMany(
          [{ _id: firstId, value: 1 }, { _id: secondId, value: 2 }],
          { session }
        );
        await session.abortTransaction();
      } finally {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        await session.endSession();
      }

      const count = await collection.countDocuments({ _id: { $in: [firstId, secondId] } });
      if (count !== 0) {
        throw new VerificationFailure("Aborted transaction left documents persisted.");
      }

      return { persistedDocumentsAfterAbort: count };
    }));

    evidence.checks.push(await runCheck("duplicateKeyAbort", async () => {
      const duplicateId = `${runId}-duplicate`;
      const stagedId = `${runId}-staged-before-duplicate`;
      await collection.insertOne({ _id: duplicateId, value: "existing" });
      const session = client.startSession();
      let duplicateKeyObserved = false;

      try {
        session.startTransaction(transactionOptions);
        await collection.insertOne({ _id: stagedId, value: "must-rollback" }, { session });

        try {
          await collection.insertOne({ _id: duplicateId, value: "duplicate" }, { session });
        } catch (error) {
          if (!error || typeof error !== "object" || error.code !== 11000) {
            throw new VerificationFailure("The conflicting insert did not fail with a duplicate-key error.");
          }
          duplicateKeyObserved = true;
        }

        if (!duplicateKeyObserved) {
          throw new VerificationFailure("Duplicate-key insert unexpectedly succeeded.");
        }

        if (session.inTransaction()) {
          await session.abortTransaction();
        }
      } finally {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        await session.endSession();
      }

      const [staged, duplicate] = await Promise.all([
        collection.findOne({ _id: stagedId }),
        collection.findOne({ _id: duplicateId })
      ]);
      if (staged !== null || duplicate?.value !== "existing") {
        throw new VerificationFailure("Duplicate-key abort did not roll back only the transaction's staged write.");
      }

      return { duplicateKeyObserved, stagedDocumentPersisted: staged !== null };
    }));

    evidence.checks.push(await runCheck("concurrentNoLostUpdate", async () => {
      const counterId = `${runId}-counter`;
      await collection.insertOne({ _id: counterId, value: 0 });

      let firstAttemptReads = 0;
      let releaseBarrier;
      const bothTransactionsRead = new Promise((resolveBarrier) => {
        releaseBarrier = resolveBarrier;
      });

      const waitForPeerRead = async () => {
        firstAttemptReads += 1;
        if (firstAttemptReads === 2) {
          releaseBarrier();
          return;
        }

        let timeout;
        try {
          await Promise.race([
            bothTransactionsRead,
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new VerificationFailure("Concurrent transaction read barrier timed out.")),
                10_000
              );
            })
          ]);
        } finally {
          clearTimeout(timeout);
        }
      };

      const incrementInTransaction = async () => {
        const session = client.startSession();
        let firstAttempt = true;
        try {
          await session.withTransaction(async () => {
            const current = await collection.findOne({ _id: counterId }, { session });
            if (!current) {
              throw new VerificationFailure("Counter document was not found.");
            }

            if (firstAttempt) {
              firstAttempt = false;
              await waitForPeerRead();
            }

            const update = await collection.updateOne(
              { _id: counterId, value: current.value },
              { $set: { value: current.value + 1 } },
              { session }
            );
            if (update.matchedCount !== 1) {
              throw new VerificationFailure("Concurrent counter update did not match its observed value.");
            }
          }, transactionOptions);
        } finally {
          await session.endSession();
        }
      };

      await Promise.all([incrementInTransaction(), incrementInTransaction()]);
      const counter = await collection.findOne({ _id: counterId });
      if (counter?.value !== 2) {
        throw new VerificationFailure("Concurrent transactions lost an update.");
      }

      return { expectedValue: 2, actualValue: counter.value };
    }));

    evidence.overall = evidence.checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";

  } catch (error) {
    evidence.setupFailure = safeFailure(error);
    const completedChecks = new Set(evidence.checks.map((check) => check.name));
    evidence.checks.push(...checkNames
      .filter((name) => !completedChecks.has(name))
      .map((name) => notExecuted(name, "Not executed because the verification setup did not complete.")));
  } finally {
    if (collection) {
      try {
        await collection.drop();
      } catch {
        evidence.cleanup = "FAIL";
        evidence.overall = "FAIL";
      }
    }

    try {
      await mongoose.disconnect();
    } catch {
      evidence.disconnect = "FAIL";
      evidence.overall = "FAIL";
    }
  }

  try {
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  } catch {
    console.error("FAIL: Could not create the evidence file. No MongoDB URI or credentials were printed.");
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ evidencePath, ...evidence }, null, 2));
  if (evidence.overall !== "PASS") {
    process.exitCode = 1;
  }
}

await main();
