#!/usr/bin/env node
/**
 * Offline wallet recovery tool. Run it on an air-gapped or at least trusted machine; it never touches the network.
 *
 *   node scripts/wallet-recover.mjs init --k 3 --n 5 --out ./recovery-ceremony
 *       Generates the recovery key. Writes public-key.json (register this in ETI) and one share-N.txt per custodian (mode 0600).
 *       The private key exists only as shares: give each share to a different person, store them separately and offline, then delete the output folder.
 *   node scripts/wallet-recover.mjs decrypt --backup wallets.etibak --share share-1.txt --share share-3.txt --share share-4.txt --out restore-bundle.json
 *       Decrypts a backup with k shares and writes the bundle to POST to /api/wallets/recovery/restore.
 *   node scripts/wallet-recover.mjs inspect --backup wallets.etibak
 *       Shows the unencrypted header (recovery set, time, event count) without any key.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newRecoverySet, openBackup, parseSealed } from "../worker/wallets/vault.ts";

const [cmd, ...rest] = process.argv.slice(2), args = { share: [] };
for (let i = 0; i < rest.length; i++) { const k = rest[i].replace(/^--/, ""); if (k === "share") args.share.push(rest[++i]); else args[k] = rest[++i]; }
const die = (m) => { console.error("error: " + m); process.exit(1); };

if (cmd === "init") {
  const k = Number(args.k ?? 3), n = Number(args.n ?? 5), out = args.out ?? "./recovery-ceremony";
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 2 || n < k || n > 16) die("need 2 <= k <= n <= 16");
  const { publicKey, shares, setId } = await newRecoverySet(k, n); mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, "public-key.json"), JSON.stringify({ publicKey, k, n, setId }, null, 2));
  shares.forEach((s, i) => writeFileSync(join(out, `share-${i + 1}.txt`), s + "\n", { mode: 0o600 }));
  console.log(`Recovery set ${setId}: ${k} of ${n}.\nRegister ${join(out, "public-key.json")} in ETI (it contains no secret).\nGive each share-N.txt to a different custodian, store them apart and offline, then delete ${out}.\nNo share or private key was sent anywhere.`);
} else if (cmd === "decrypt") {
  if (!args.backup || args.share.length < 2 || !args.out) die("usage: decrypt --backup FILE --share FILE --share FILE [...] --out FILE");
  const text = readFileSync(args.backup, "utf8"), r = await openBackup(text, args.share.map((f) => readFileSync(f, "utf8").trim()));
  if (!r.ok) die(r.error);
  writeFileSync(args.out, JSON.stringify({ backup: text, events: r.events }), { mode: 0o600 });
  console.log(`Decrypted ${r.events.length} events from the backup made ${new Date(r.backup.createdAt).toISOString()}. Wrote ${args.out}. The bundle holds no keys; delete it after the restore.`);
} else if (cmd === "inspect") {
  const b = parseSealed(readFileSync(args.backup ?? "", "utf8")); if (!b) die("not an ETI wallet backup");
  console.log(JSON.stringify({ setId: b.setId, createdAt: new Date(b.createdAt).toISOString(), events: b.count }, null, 2));
} else die("commands: init | decrypt | inspect");
