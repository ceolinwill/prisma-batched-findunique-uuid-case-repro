import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.ts";

const connectionString = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/repro";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
  log: [{ emit: "event", level: "query" }],
});

let statements: string[] = [];
prisma.$on("query", (event) => statements.push(`${event.query} -- ${event.params}`));

const a = randomUUID();
const b = randomUUID();
const user = randomUUID();
const group = randomUUID();

await prisma.item.createMany({ data: [{ id: a }, { id: b }] });
await prisma.membership.create({ data: { groupId: group, userId: user } });

const select = { id: true } as const;
const settle = async (promises: Promise<unknown>[]) =>
  (await Promise.allSettled(promises)).map((result) =>
    result.status === "fulfilled" ? result.value : `${result.reason.code}: ${result.reason.message.trim().split("\n").at(-1)}`,
  );

const cases = [
  {
    expected: [{ id: a }],
    label: "findUnique, one call, uppercase id",
    run: () => settle([prisma.item.findUnique({ select, where: { id: a.toUpperCase() } })]),
  },
  {
    expected: [{ id: a }, { id: a }],
    label: "findUnique x2 at once, lowercase + uppercase id of the same row",
    run: () =>
      settle([
        prisma.item.findUnique({ select, where: { id: a } }),
        prisma.item.findUnique({ select, where: { id: a.toUpperCase() } }),
      ]),
  },
  {
    expected: [{ id: a }, { id: b }],
    label: "findUnique x2 at once, uppercase ids of two rows",
    run: () =>
      settle([
        prisma.item.findUnique({ select, where: { id: a.toUpperCase() } }),
        prisma.item.findUnique({ select, where: { id: b.toUpperCase() } }),
      ]),
  },
  {
    expected: [{ id: a }, { id: a }],
    label: "findUniqueOrThrow x2 at once, lowercase + uppercase id",
    run: () =>
      settle([
        prisma.item.findUniqueOrThrow({ select, where: { id: a } }),
        prisma.item.findUniqueOrThrow({ select, where: { id: a.toUpperCase() } }),
      ]),
  },
  {
    expected: [{ id: a }, { id: a }],
    label: "findUnique x2 in an interactive $transaction",
    run: () =>
      prisma.$transaction((tx) =>
        settle([
          tx.item.findUnique({ select, where: { id: a } }),
          tx.item.findUnique({ select, where: { id: a.toUpperCase() } }),
        ]),
      ),
  },
  {
    expected: [{ id: a }, { id: a }],
    label: "findUnique x2 in a batch $transaction([...])",
    run: () =>
      prisma.$transaction([
        prisma.item.findUnique({ select, where: { id: a } }),
        prisma.item.findUnique({ select, where: { id: a.toUpperCase() } }),
      ]),
  },
  {
    expected: ["found", "found"],
    label: "findUnique x2 at once, compound unique with an uppercase uuid part",
    run: async () =>
      (
        await settle([
          prisma.membership.findUnique({ where: { userId_groupId: { groupId: group, userId: user } } }),
          prisma.membership.findUnique({ where: { userId_groupId: { groupId: group, userId: user.toUpperCase() } } }),
        ])
      ).map((row) => (row ? "found" : row)),
  },
  {
    expected: [{ id: a }, { id: a }],
    label: "control: findFirst x2 at once, lowercase + uppercase id",
    run: () =>
      settle([
        prisma.item.findFirst({ select, where: { id: a } }),
        prisma.item.findFirst({ select, where: { id: a.toUpperCase() } }),
      ]),
  },
];

let failures = 0;

for (const { expected, label, run } of cases) {
  statements = [];
  const result = await run();
  const ok = JSON.stringify(result) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`\n${ok ? "ok  " : "FAIL"} ${label}\n     got ${JSON.stringify(result)}`);
  for (const statement of statements) console.log(`     ${statement}`);
}

await prisma.item.deleteMany();
await prisma.membership.deleteMany();
await prisma.$disconnect();

console.log(
  failures === 0
    ? "\nOK: every lookup found its row."
    : `\nBUG: ${failures} case(s) lost a row the database returned. PostgreSQL matched the uppercase uuid; the client didn't.`,
);

process.exitCode = failures === 0 ? 0 : 1;
