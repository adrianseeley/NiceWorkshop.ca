#!/usr/bin/env node
'use strict';

// By default this only writes ignored review files. --send sends exactly these
// two obvious test previews to the owner's authorized test address, never customers.
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMailSender, renderReadyEmail } = require('../server/email');

const RECIPIENT = 'hello@niceworkshop.ca';

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--send')) {
    throw new Error('Usage: node scripts/send-email-previews.js [--send]');
  }
  const directory = path.resolve(__dirname, '../output/email-previews');
  const cutList = [{ sheetId: 'birch-12-7', shape: 'rectangle', widthUnits: 3048000, heightUnits: 6096000, quantity: 3 }];
  const previews = [
    { name: 'pickup-ready', ...renderReadyEmail({ kind: 'pickup', orderName: '#TEST-PICKUP', cutList, test: true }) },
    { name: 'dropoff-ready', ...renderReadyEmail({ kind: 'delivery', orderName: '#TEST-DROPOFF', cutList, test: true }) },
  ];
  await mkdir(directory, { recursive: true });
  for (const preview of previews) {
    await writeFile(path.join(directory, `${preview.name}.html`), preview.html);
    await writeFile(path.join(directory, `${preview.name}.txt`), `${preview.subject}\n\n${preview.text}\n`);
  }
  if (!argv.includes('--send')) return { action: 'rendered', directory, sent: 0 };

  const sender = createMailSender(env);
  if (!sender) throw new Error('Email is disabled. Configure EMAIL_ENABLED=true and dedicated SMTP credentials before sending previews.');
  const runId = randomUUID();
  const receiptFile = path.join(directory, `send-${runId}.json`);
  const receipts = [];
  for (const preview of previews) {
    const receipt = { template: preview.name, recipient: RECIPIENT,
      messageId: `<preview-${runId}-${preview.name}@niceworkshop.ca>`, outcome: 'unknown' };
    receipts.push(receipt);
    // Persist before contacting SMTP: a terminated process must not suggest a safe retry.
    await writeFile(receiptFile, JSON.stringify(receipts, null, 2));
    try {
      await sender.send({ to: RECIPIENT, subject: preview.subject, text: preview.text,
        html: preview.html, messageId: receipt.messageId });
      receipt.outcome = 'accepted';
    } catch (error) {
      receipt.outcome = error.deliveryOutcome || 'unknown';
      await writeFile(receiptFile, JSON.stringify(receipts, null, 2));
      throw new Error(`Preview ${preview.name}: ${receipt.outcome}. Review ${receiptFile} and the mailbox before trying again.`);
    }
    await writeFile(receiptFile, JSON.stringify(receipts, null, 2));
  }
  return { action: 'accepted_by_smtp', recipient: RECIPIENT, count: receipts.length, receiptFile };
}

if (require.main === module) main().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { main };
