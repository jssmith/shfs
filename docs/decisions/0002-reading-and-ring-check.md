# 0002 · Reading and the ring check

- **Question:** Does the ring check catch sensitive files, scans and photos included, well enough to meet the pass marks in security design §2? (Wave 1, uncertainty 3; experiment E3.)
- **Measured:** extraction (text, PDF text layers, OCR) and the ring check (rules, then rules with a small local model) over two synthetic corpora of 1,282 files each, with ground truth. Numbers below.
- **Answer:** not yet. On typed text both stages catch everything in this corpus. On photos and screenshots they do not: with rules only, 25 sensitive items leaked on the held-out seed; with rules and a local model, 2 (both credentials). The zero-miss credential mark, the 98% marks for finance and identity, and the 5% uncertain mark are not met; precision is.
- **Decision:** rules and model together, on every item; images stay uncertain unless placed; only non-sensitive folders go in until a real-file sample is measured. Details under [Decision](#decision).
- **Would change it:** a labelled sample of real files; a vision model for photos. See [What would change it](#what-would-change-it).

## What was built

| Part | Where |
| --- | --- |
| Corpus generator, deterministic from a seed, with `manifest.json` | `test/fixtures/generate` (wraps `generate.py`; run with `python3 -I`) |
| `extract()` per contracts §3 | `server/src/reading/extract.ts` |
| `ringCheck()` per contracts §3: rule stage, model stage, decision | `server/src/reading/rules.ts`, `checksums.ts`, `model.ts`, `ring-check.ts` |
| Measurement against the pass marks | `server/src/reading/measure.ts` |
| Tests | `server/src/reading/*.test.ts`, `test/src/corpus.test.ts` |

### The corpus

Every file is invented. Card numbers pass Luhn, IBANs pass mod-97, passport MRZ lines carry correct ICAO check digits, NHS numbers pass mod-11, but all are random and paired with invented names and institutions.

| Ground truth | Files | Examples |
| --- | --- | --- |
| `ring:credentials` (the dedicated set) | 240 | recovery codes, password-manager CSV exports (5 formats), PEM and OpenSSH keys, `.env`/YAML/JSON with API keys (AWS, GitHub, Stripe, Slack, Google, GitLab, npm, SendGrid, Twilio, JWT), BIP39 seed phrases, TOTP secrets, password lists, kubeconfig; 106 of them as screenshots, photos or scans |
| `ring:finance` | 170 | bank, card and brokerage statements, tax forms, payslips, transfers, mortgage letters, photos of cards and cheques |
| `ring:identity` | 121 | passports and ID cards (with MRZ), driver licences, SSN cards, birth certificates, residence permits, identity-check forms; tax forms and payslips that carry a full SSN or NI number are in both finance and identity |
| `ring:health` | 110 | referral letters, lab reports, prescriptions, discharge summaries, therapy notes, vaccination records, insurance EOBs, fit notes |
| `ring:intimate` | 80 | love letters, diary entries, notes before a difficult talk (tasteful, no images) |
| none | 580 | receipts, contracts, notes, recipes, code, articles, invoices, shipping labels, tickets, manuals, 40 photos of objects with no text; 233 of these are hard negatives (a recipe about "account" and "closing balance", invoices with 16-digit numbers, an article on renewing a passport, a crypto article about seed phrases, code with the AWS documentation key and the Stripe test card, meeting notes about password resets) |

Renderings: 480 plain-text files, 166 text-layer PDFs, and 636 images or scanned PDFs (seed 1): clean scans (115 images, 111 PDFs, slight rotation and noise), screenshots (87, some photographed off a screen), phone photos (224: rotation up to ±8°, 8% turned 90/180/270°, uneven light, blur, downscaling, JPEG), barely legible photos (59: low contrast, heavy noise, half resolution). File names mix descriptive names with `Scan_0042.jpg`-style ones. Receipts are deliberately ordinary (they show only the last four card digits).

Regenerate with `test/fixtures/generate --out /tmp/a1-corpus --seed 1` (about a minute; the same seed gives identical bytes, checked by `sha256sum` over two runs and by `test/src/corpus.test.ts`).

### Extraction

`pdftotext` for PDFs with a text layer (at least 40 characters per page); otherwise `pdftoppm -r 200 -gray` and OCR. OCR is `tesseract … tsv` with `OMP_THREAD_LIMIT=1`; confidence is the mean word confidence. If the first pass is weak (confidence below 0.8 or under 5 words) and ImageMagick is present, a second pass runs on a cleaned copy (orientation from `tesseract --psm 0`, grey, upscaled to 1600 px, normalised, sharpened), then single-block mode, then the other three orientations, keeping the best.

### The rule stage

High-precision patterns, checksums where they exist, each with a score; scores for a ring combine by noisy-OR. A ring is assigned at 0.7; 0.5 to 0.7 makes the item uncertain.

| Ring | Rules |
| --- | --- |
| credentials | PEM/PGP private-key headers; known key prefixes (AWS, GitHub, Stripe live, Slack, `sk-`, Google, GitLab, npm, SendGrid, Twilio, JWT, `otpauth://`); `secret = value` assignments and upper-case env names (`*_KEY=`, `*_TOKEN=`) with placeholder and documentation-example filters; password-manager CSV headers; recovery-code wording with code-shaped lines; 12 BIP39 words in a row (11 of 12 tolerated for OCR); TOTP keys; password lists; base64 key material; matched also on copies with OCR spaces removed. Any credentials hit at 0.7 or more assigns the ring; anything between 0.5 and 0.7 makes the item uncertain even when another ring is assigned |
| finance | card numbers (Luhn, IIN 3–6, documented test cards excluded) with card words nearby; IBAN (mod-97 and country length); ABA routing numbers (checksum) next to "routing"; account numbers after "account number"; cheque wording and MICR; statement keywords |
| identity | MRZ lines (ICAO check digits; OCR's `c`/`e`/`k` for `<` repaired); SSNs (SSA ranges) with or without a label; UK NI numbers; document numbers after "passport no." etc.; labelled identity fields ("Surname X", "Date of birth 01/02/1980"); keywords alone are capped at uncertain |
| health | NHS numbers (mod-11), MRNs, ICD-10 codes next to "diagnosis", vaccination records, clinical keywords |
| intimate | keywords and phrases only |

Keyword evidence alone needs two distinct strong terms to assign a ring; otherwise at most uncertain. Reasons name the rule and a masked value (`sk_l…******24`), never the secret.

Unreadable input (under 15 non-space characters, or `method: 'none'`) is uncertain; so is OCR text below 0.45 mean confidence when no ring was found.

### The model stage

A small local model through Ollama's `/api/chat` with a JSON schema: given the file name, type and the first 1,500 characters, it names the one ring that fits best (or none) and a confidence (high, medium, low → 0.9, 0.7, 0.5). It runs on every item with text; it can only add rings (assign at 0.8; 0.6 to 0.8 makes an unplaced item uncertain). A model error makes an unplaced item uncertain. Configured with `AGENT_DRIVE_RING_MODEL` and `AGENT_DRIVE_OLLAMA_URL`; with no model set, the stage is a stub and only rules run.

The Ollama binary (from ollama.com, which redirects to GitHub release assets) and model weights (registry.ollama.ai) downloaded without trouble on this machine.

Which model: two small open-weight instruction models were tried, 1.5 and 3 billion parameters, 4-bit quantised (about 1 GB and 2.4 GB), CPU only. The exact tags are in the spike's report to the lead, not here, by the repository's rule on model names. On a 48-item sample of seed 1, asked for the single best ring, the 1.5B model was right on 22 items and the 3B model on 40. An earlier prompt that asked for a 0–100 score per ring failed with both: the smaller model answered 100 for most rings on most items. The 3B model with the single-ring prompt is the one measured below.

## Results

How: `npm run build`, then `node server/dist/reading/measure.js --corpus <dir> --cache <dir> --jobs 3 [--model <tag> --ollama http://127.0.0.1:9111]`. Machine: 4 shared CPUs (other agents were building and running sandboxes at the same time), no GPU.

Seed 1 is the corpus the rules were tuned on. Seed 2 is the same generator with a different seed: new numbers, names, phrasings, degradations and file mix, but the same templates, so it shows over-fitting to particular values, not to the kinds of documents.

### Rules only

| Ring | Recall, seed 1 (tuned) | Recall, seed 2 (held out) | Held (ring or uncertain), seed 2 | Leaked, seed 2 | Precision, seed 2 | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| credentials (240) | 88.8% (213) | 88.8% (213) | 96.7% | 8 | 100% | zero misses: **not met** (27 misses) |
| finance (170) | 92.4% | 87.6% | 96.5% | 6 | 100% | ≥98%: **not met** |
| identity (121 / 124) | 87.6% | 83.9% | 93.5% | 8 | 100% | ≥98%: **not met** |
| health (110) | 94.5% | 94.5% | 98.2% | 2 | 100% | ≥97%: **not met** |
| intimate (80) | 95.0% | 95.0% | 98.8% | 1 | 100% | ≥97%: **not met** |
| Precision, any ring | 99.7% | 100% | | | | ≥60%: **met** |
| Left uncertain | 13.4% | 11.9% | | | | ≤5%: **not met** |

"Recall" counts an item only when its true ring is assigned. "Held" adds items left uncertain: those stay unreachable and go to the person, so they are not leaks, but they are the person's work. "Leaked" items got no ring and no flag: an agent could read them.

Recall by rendering, seed 2 (seed 1 within a few points):

| Rendering | credentials | finance | identity | health | intimate |
| --- | --- | --- | --- | --- | --- |
| text (plain files, text-layer PDFs) | 100% (139/139) | 100% (83/83) | 100% (22/22) | 100% (68/68) | 100% (41/41) |
| clean scans and screenshots | 86.2% (56/65) | 100% (34/34) | 95.9% (47/49) | 96.4% (27/28) | 100% (24/24) |
| phone photos | 59.3% (16/27) | 83.3% (30/36) | 81.0% (34/42) | 90.0% (9/10) | 73.3% (11/15) |
| barely legible photos | 22.2% (2/9) | 11.8% (2/17) | 9.1% (1/11) | 0% (0/4) | n/a |

Why items were left uncertain, seed 2 (153 of 1,282):

| Cause | Sensitive | Ordinary |
| --- | --- | --- |
| No readable text (photos of objects, illegible photos) | 20 | 44 |
| Low OCR confidence | 18 | 7 |
| Weak rule signal (keywords only) | 11 | 53 |

### Rules and model

Seed 2 (held out), 3B model, run on all 1,244 items with text, one at a time: median 3.0 s per item, p90 4.6 s, about 65 minutes for the corpus on the shared 4 CPUs, no errors.

| Ring | Recall | Held | Leaked | Precision | Mark |
| --- | --- | --- | --- | --- | --- |
| credentials (240) | 93.8% (225) | 99.2% | 2 | 87.9% | zero misses: **not met** (15 misses, 13 of them held as uncertain) |
| finance (170) | 95.9% | 100% | 0 | 72.4% | ≥98%: **not met** |
| identity (124) | 94.4% | 100% | 0 | 86.7% | ≥98%: **not met** |
| health (110) | 97.3% | 100% | 0 | 93.0% | ≥97%: **met** |
| intimate (80) | 100% | 100% | 0 | 81.6% | ≥97%: **met** |
| Precision, any ring | 85.2% | | | | ≥60%: **met** |
| Left uncertain | 7.8% (6.0% if the model may settle weak rule suspicion) | | | | ≤5%: **not met** |

Recall by rendering with the model, seed 2:

| Rendering | credentials | finance | identity | health | intimate |
| --- | --- | --- | --- | --- | --- |
| text | 100% | 100% | 100% | 100% | 100% |
| clean scans and screenshots | 93.8% (61/65) | 100% | 95.9% (47/49) | 96.4% (27/28) | 100% |
| phone photos | 85.2% (23/27) | 97.2% (35/36) | 97.6% (41/42) | 100% | 100% |
| barely legible photos | 22.2% (2/9) | 64.7% (11/17) | 63.6% (7/11) | 50.0% (2/4) | n/a |

What the model adds and costs:

- It reads damaged OCR text far better than patterns do. Phone-photo recall rises from 59–90% to 85–100%, and leaks fall from 25 to 2 across all rings.
- It wrongly rings 118 of 580 ordinary items (rules alone: 0): code is called credentials (17), articles are called identity, intimate, credentials or health (44), shipping labels, receipts and adverts are called finance (38). Precision stays above the 60% mark, but each of these is a prompt to the person or an item hidden from agents.
- The uncertain share is now set by items with no readable text: 64 of 1,282 (5.0%) on their own, 40 of them photos of objects. No text model can clear those.
- The two credential leaks are photos whose OCR kept almost nothing (`"s lack\nbot\n"region: x`); the model, like the rules, sees no credential.

### OCR throughput

| Run | OCR files | Wall time, 3 jobs | Files per minute | Per file: median / p90 / max |
| --- | --- | --- | --- | --- |
| Seed 1, single pass plus cleaned pass | 636 | 267 s | 143 | 0.8 s / 2.7 s / 14 s |
| Seed 1, plus the extra orientations (final) | 636 | 533 s | 72 | 1.0 s / 7.1 s / 24 s |
| Seed 2, final | 604 | 366 s | 99 | 0.7 s / 5.5 s / 15 s |

Clean pages take under a second; poor photos take most of the time because each extra pass is another full OCR. Text files and text-layer PDFs: about 25,000 per minute. A 10,000-file upload with 40% images would take one to two hours of OCR on this machine.

## What misses look like

All misses on text, by any rule, are zero on both seeds, but the text was generated from the same templates the rules were tuned on (see Caveats). The misses are all in OCR output:

- **Keys in photos.** `ghp_JMhmENf pbEBztxQt 64hW…` (spaces inside the token: now caught), `GITLAB_TOKEN=g lpat - rUx1…`, a JWT read as `ey JhbGci0i JTUZTINi …`, a Slack token reduced to `"s lack\nbot"`. Prefix rules fail as soon as OCR breaks the prefix.
- **Seed phrases photographed on paper.** OCR returns 8 of 12 words, or splits them (`faitt`, `kiw ar`); the 11-of-12 rule cannot fire.
- **Recovery codes on a photographed screen.** `Save these ¢ odes`, codes read as `Laat nns?`.
- **Card photos.** The number is read with one wrong digit, so Luhn fails; the card-face rule (`VALID THRU`) catches most, not all.
- **Upside-down and sideways photos.** OSD misses some; the orientation retries fix most at a large time cost.
- **Barely legible photos.** Tesseract returns noise (confidence under 0.3). These are held as uncertain, which is correct, but they never get a ring.
- **Keyword traps.** Articles about bank fees, renewing a passport or staying well in winter, and the recipe with "closing balance", land in uncertain under rules alone.

## Decision

1. **Neither stage passes all the marks on photos, and rules alone cannot.** Precision is met easily; recall on photos and the uncertain share are not. The credential mark (zero misses) is missed on photos and screenshots of credentials: 27 misses of 240 on each seed, of which 4 (seed 1) and 8 (seed 2) are outright leaks and the rest are held as uncertain.
2. **Keep the thin-drive rule: only non-sensitive folders go in.** On typed text the rules look strong, but this corpus cannot show how they do on real documents with unseen layouts and wording.
3. **Treat every image as uncertain unless a rule places it, until a vision step exists.** OCR is the weak link, not the rules: recall on clean scans is 86–100%, on phone photos 59–90%, on barely legible photos near 0%. Photos of objects (and intimate photos, which this corpus does not contain) have no text at all, and only an image description could clear them.
4. **Use the model stage, on every item, as the design says.** With rules only, 25 sensitive items leaked on seed 2; with the model, 2. The model costs about 3 seconds per item on CPU and about 9% of ordinary items wrongly ringed. That is the right trade for a wall. Keep `modelClears` off by default: it lowers the uncertain share by 2 points but lets the model loosen, which the design reserves for the person.
5. Ship `extract()` and `ringCheck()` as they are behind the contract, with the model stage switched by configuration.

## What would change it

- **A sample of Johann's real files**, labelled. This is the measurement that matters; the synthetic corpus checks that the machinery works and finds OCR failure modes, but it measures the rules against templates they were tuned on.
- **A vision model** that reads photos directly (and describes images without text) would replace OCR as the weak link for photos and resolve most of the uncertain share.
- **A stronger local model on better hardware** (the drive VM, or a GPU) would change the cost side of the model stage.
- **A different uncertain budget.** At ≤5% uncertain, either the model settles weak keyword matches (measured above) or the keyword threshold drops, which turns some held items into leaks.

## Caveats

- The rules were tuned by reading misses on seed 1. Seed 2 shares the generator's templates, so it is held out for values and degradations, not for document types or wording. Real recall on typed text will be lower than the 100% measured here, especially for intimate and health documents, whose rules are keyword lists.
- Intimate items are letters and diaries only; there are no intimate photos.
- The barely legible tier is harsher than most real phone photos; it is reported separately.
- Ground truth is one labeller's convention: receipts and invoices are ordinary; tax forms and payslips with a full national number are also identity.
- Timings are on a shared 4-CPU machine under load from other agents; treat them as rough.
