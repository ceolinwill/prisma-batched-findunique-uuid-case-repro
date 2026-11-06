# Batched `findUnique` loses rows looked up by an uppercase UUID

Prisma Client batches `findUnique` calls made in the same tick into one `WHERE id IN (...)` query, then hands each call its row by comparing the call's arguments to the returned row in JavaScript with `===`. PostgreSQL's `uuid` type accepts any letter case and returns lowercase, so a call whose id is uppercase never matches the row the database returned: it resolves to `null` (`findUniqueOrThrow` throws P2025). The same call on its own finds the row, so the result depends on whether another lookup happened to run at the same moment.

Reported in [prisma/orm#25484](https://github.com/prisma/orm/issues/25484).

## Reproduction

Needs a PostgreSQL database. Any empty one works; for example:

```sh
docker run -d --name repro-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=repro postgres:18
```

Then (set `DATABASE_URL` if yours isn't `postgres://postgres:postgres@localhost:5432/repro`):

```sh
npm install
npm run repro
```

`npm run repro` pushes the schema (two tables), generates the client and runs [`repro.ts`](repro.ts), which inserts two rows, runs each case and logs the statements it sent. It exits with 1 while the bug is present.

Output on Prisma 7.10.1:

```
ok   findUnique, one call, uppercase id
     got [{"id":"7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256"}]
     SELECT "public"."Item"."id" FROM "public"."Item" WHERE ("public"."Item"."id" = $1 AND 1=1) LIMIT $2 OFFSET $3 -- ["7C60FBF3-8E8E-4A7F-ABCA-F77C7C1F6256","1","0"]

FAIL findUnique x2 at once, lowercase + uppercase id of the same row
     got [{"id":"7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256"},null]
     SELECT "public"."Item"."id" FROM "public"."Item" WHERE "public"."Item"."id" IN ($1,$2) OFFSET $3 -- ["7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256","7C60FBF3-8E8E-4A7F-ABCA-F77C7C1F6256","0"]

FAIL findUnique x2 at once, uppercase ids of two rows
     got [null,null]
     SELECT "public"."Item"."id" FROM "public"."Item" WHERE "public"."Item"."id" IN ($1,$2) OFFSET $3 -- ["7C60FBF3-8E8E-4A7F-ABCA-F77C7C1F6256","5BF01422-4FD9-4537-AA81-440C00C1FECB","0"]

FAIL findUniqueOrThrow x2 at once, lowercase + uppercase id
     got [{"id":"7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256"},"P2025: An operation failed because it depends on one or more records that were required but not found"]
     SELECT "public"."Item"."id" FROM "public"."Item" WHERE "public"."Item"."id" IN ($1,$2) OFFSET $3 -- ["7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256","7C60FBF3-8E8E-4A7F-ABCA-F77C7C1F6256","0"]

FAIL findUnique x2 in an interactive $transaction
     got [{"id":"7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256"},null]
     SELECT "public"."Item"."id" FROM "public"."Item" WHERE "public"."Item"."id" IN ($1,$2) OFFSET $3 -- ["7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256","7C60FBF3-8E8E-4A7F-ABCA-F77C7C1F6256","0"]
     COMMIT -- []

FAIL findUnique x2 in a batch $transaction([...])
     got [{"id":"7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256"},null]
     SELECT "public"."Item"."id" FROM "public"."Item" WHERE "public"."Item"."id" IN ($1,$2) OFFSET $3 -- ["7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256","7C60FBF3-8E8E-4A7F-ABCA-F77C7C1F6256","0"]

FAIL findUnique x2 at once, compound unique with an uppercase uuid part
     got ["found",null]
     SELECT "public"."Membership"."id", "public"."Membership"."userId", "public"."Membership"."groupId" FROM "public"."Membership" WHERE (("public"."Membership"."groupId" = $1 AND "public"."Membership"."userId" = $2) OR ("public"."Membership"."groupId" = $3 AND "public"."Membership"."userId" = $4)) OFFSET $5 -- ["78df5e8b-9923-4255-8b06-83ea7bb3c4fe","5163d1f0-5b46-4fa4-8145-9b45fd5afd60","78df5e8b-9923-4255-8b06-83ea7bb3c4fe","5163D1F0-5B46-4FA4-8145-9B45FD5AFD60","0"]

ok   control: findFirst x2 at once, lowercase + uppercase id
     got [{"id":"7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256"},{"id":"7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256"}]
     SELECT "public"."Item"."id" FROM "public"."Item" WHERE "public"."Item"."id" = $1 LIMIT $2 OFFSET $3 -- ["7c60fbf3-8e8e-4a7f-abca-f77c7c1f6256","1","0"]
     SELECT "public"."Item"."id" FROM "public"."Item" WHERE "public"."Item"."id" = $1 LIMIT $2 OFFSET $3 -- ["7C60FBF3-8E8E-4A7F-ABCA-F77C7C1F6256","1","0"]

BUG: 6 case(s) lost a row the database returned. PostgreSQL matched the uppercase uuid; the client didn't.
```

(The ids are random on each run.)

## Expected

Every case finds its row, as the single uppercase `findUnique` and both `findFirst` calls do. Whether a lookup finds a row shouldn't depend on another lookup running at the same time.

## Actual

The batched statement returns the row, but the client drops it:

- `getBatchId` ([`packages/client/src/runtime/core/jsonProtocol/getBatchId.ts`](https://github.com/prisma/orm/blob/7.10.1/packages/client/src/runtime/core/jsonProtocol/getBatchId.ts)) groups `findUnique`/`findUniqueOrThrow` calls by model, argument keys and selection, not values, so lookups of different rows share a batch. `RequestHandler`'s `batchBy` ([L122-L136](https://github.com/prisma/orm/blob/7.10.1/packages/client/src/runtime/RequestHandler.ts#L122-L136)) batches inside interactive and batch transactions too.
- `convertCompactedRows` ([`packages/client-engine-runtime/src/batch.ts` L93-L101](https://github.com/prisma/orm/blob/7.10.1/packages/client-engine-runtime/src/batch.ts#L93-L101)) finds each call's row with `doKeysMatch(rowKeys, resolvedArgs)` and returns `null` (or P2025 when `expectNonEmpty`) when none matches.
- `doKeysMatch` ([`packages/client-engine-runtime/src/utils.ts` L64-L72](https://github.com/prisma/orm/blob/7.10.1/packages/client-engine-runtime/src/utils.ts#L64-L72)) compares two strings with `===`. The row's id is PostgreSQL's canonical lowercase text; the argument is whatever the caller passed, so they differ by case and the call gets nothing.

The same mismatch should follow from any value the database matches more loosely than `===`; the issue thread shows it with a case-insensitive SQL Server collation.

## Environment

- `prisma`, `@prisma/client`, `@prisma/adapter-pg` 7.10.1 (the latest `@prisma/client` release), `prisma-client` generator, `pg` 8.23.1
- PostgreSQL 18
- Node.js 24.22.0, npm 11.19.1, macOS 27.2
