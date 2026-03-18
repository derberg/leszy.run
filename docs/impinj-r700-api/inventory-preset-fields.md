# Impinj R700 — Inventory Preset Field Reference

Researched 2026-03-04. Sources: Impinj Support Portal articles (403 on direct access),
web search results, cross-referenced with working LeszyRun preset (firmware 9.1.0).

Official docs (login required):
- RF Modes: https://support.impinj.com/hc/en-us/articles/1500003045181-Impinj-R700-Reader-Modes-RF-Modes
- TX Power table: https://support.impinj.com/hc/en-us/articles/1500003981601-Receive-Sensitivity-and-Transmit-Power-Index-Value-Table
- Session/SearchMode guide: https://support.impinj.com/hc/en-us/articles/360017167239

---

## transmitPowerCdbm

Unit: centidBm (cdbm = dBm × 100). Step: **25 cdbm (0.25 dBm)**.

Max depends on power source and regulatory region:

| Power source | Max cdbm | Max dBm |
|---|---|---|
| PoE (802.3af) | ~3000 | 30.0 |
| PoE+ ETSI lower band | 3150 | 31.5 |
| PoE+ FCC / ETSI upper band | 3300 | 33.0 |

Minimum: ~1000 cdbm (10 dBm).

LeszyRun default: **3150** (31.5 dBm, PoE+).

---

## inventorySession

EPC Gen2 session flag. Controls how long a tag stays "quiet" (in state B) after being read,
before returning to state A (readable again).

| Value | Approx. quiet time |
|---|---|
| 0 | Immediate — tag returns to A almost instantly |
| 1 | ~500 ms |
| 2 | ~2 s (recommended) |
| 3 | ~8 s |

**Note:** Exact times are tag-dependent (governed by persistence flag in tag firmware).
Session 2 is a good default for gate timing — reduces duplicate reads when a runner
lingers in range for several seconds.

LeszyRun default: **2**

---

## inventorySearchMode

Controls whether the reader cycles between tag state A and state B.

| Value | Behaviour |
|---|---|
| `single-target` | Reads only tags in state A. Faster but may miss tags that flip to B. |
| `dual-target` | Reads A, flips to B, reads B, flips back to A. Ensures full coverage. |
| `single-target-with-suppression` | Like single-target but with reader-side duplicate suppression. |

LeszyRun default: **dual-target** (best for dense-population gates with session 2)

---

## estimatedTagPopulation

Hint for the EPC Gen2 Q algorithm. The reader uses this to tune the number of
timeslots in each inventory round to minimize collisions.

- Too low → many collisions → slow reads
- Too high → wasted empty slots → slow reads
- Good rule of thumb: set to the **maximum number of tags you expect simultaneously
  in the antenna field** (not total participants)

LeszyRun default: **32** (suitable for up to ~20 runners in the gate at once)

Increase to 64–128 for mass-start events. Decrease to 8–16 for single-runner testing.

---

## rfMode

Impinj-specific DRMID (Dense Reader Mode ID). Defines the RF physical layer:
Backscatter Link Frequency (BLF) and encoding (FM0 / Miller M2/M4/M8).

**R700 does NOT support mode 1000.** If you need mode 1000 behaviour, use 1002.
(Confirmed by Impinj: "R700 supports the same RF Modes as Speedway R420 except for mode 1000.")

### AutoSet modes (dynamic — reader cycles through several sub-modes automatically)

| ID | Name |
|---|---|
| 1002 | AutoSet Dense Reader Deep Scan |
| 1003 | AutoSet Static Fast |
| 1004 | AutoSet Static Dense Reader |

AutoSet modes optimise automatically but introduce variable latency — avoid for
gate timing where deterministic read behaviour matters.

### Static modes (R700-specific)

| ID | Notes |
|---|---|
| 1210 | Default R700 static mode. LeszyRun default. Good balance of range and speed. |
| 1220 | Higher range variant. Use with long cable runs or difficult RF environments. |

Exact BLF/encoding values for 1210/1220 are not published in accessible Impinj docs
(portal returns 403). Values confirmed to work on firmware 9.1.0.

LeszyRun default: **1210**

---

## Notes on what was NOT verified

- Exact BLF (kHz) and Miller encoding (M2/M4) for modes 1210 and 1220 — not found
  in publicly accessible docs. If you have portal access, see the RF Modes article above.
- Full list of all valid rfMode IDs — portal blocked. The above list is what was found
  via web search and cross-referenced with working configs.
- Minimum transmitPowerCdbm — 1000 cdbm (10 dBm) found in one source, unconfirmed.
