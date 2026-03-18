# Impinj R700 REST API — Known Endpoints

Base URL: `https://<reader-ip>/api/v1`
Auth: HTTP Basic (`root` / empty password by default)
TLS: Self-signed cert — use `rejectUnauthorized: false` in Node.js clients

Firmware tested: **9.1.0**

Official API docs (login required): https://platform.impinj.com/site/docs/reader_api/index.gsp
OpenAPI spec download (login required): https://support.impinj.com/hc/en-us/articles/32195454977555-Impinj-IoT-Device-Interface-API-OpenAPI-Spec

---

## Status

| Method | Path | Description |
|---|---|---|
| GET | `/status` | Reader status (see schema below) |
| GET | `/system` | Static hardware info: manufacturer, model, SKU, serial |
| GET | `/system/image` | Firmware version: `primaryFirmware`, `secondaryFirmware`, `buildDate` |
| GET | `/system/temperature` | `{ "systemTemperature": 47 }` — degrees Celsius |
| GET | `/system/time` | `{ "systemTime": "...", "upTime": 38628 }` — upTime in seconds |
| GET | `/system/power` | `{ "powerSource": "auto", "allocatedPowerMilliwatts": 25500 }` |
| GET | `/system/hostname` | `{ "hostname": "impinj-17-0a-30" }` |

### `/status` response schema

```json
{
  "interface": "IoT",
  "status": "running",
  "time": "2026-03-04T07:43:07Z",
  "serialNumber": "37025450820",
  "mqttBrokerConnectionStatus": "connected",
  "mqttTlsAuthentication": "none",
  "kafkaClusterConnectionStatus": "disconnected",
  "activePreset": { "id": "leszyrun", "profile": "inventory" },
  "eventWebhookStatus": { "status": "disabled" }
}
```

`status` values: `"running"`, `"idle"`, `"starting"`, `"stopping"`

---

## MQTT

| Method | Path | Description |
|---|---|---|
| GET | `/mqtt` | Read current MQTT config |
| PUT | `/mqtt` | Write MQTT config (see mqtt.md for full schema) |

---

## Inventory Profiles

| Method | Path | Description |
|---|---|---|
| GET | `/profiles/inventory/presets` | List preset IDs |
| GET | `/profiles/inventory/presets/{presetId}` | Read a preset |
| PUT | `/profiles/inventory/presets/{presetId}` | Create/update an inventory preset |
| POST | `/profiles/inventory/presets/{presetId}/start` | Start inventory using preset |
| POST | `/profiles/stop` | Stop any running inventory/profile |

### Start / Stop notes

- **Start**: `POST` with body `{}` — returns 204 on success, 409 if already running
- **Stop**: `POST /profiles/stop` with body `{}` — returns 204 on success
- **Wrong paths** (all return 404): `PUT /profiles/inventory/presets/{id}/start`, `PUT /profiles/inventory/stop`, `POST /profiles/inventory/stop`

### Preset body schema (LeszyRun preset)

```json
{
  "antennaConfigs": [
    {
      "antennaPort": 1,
      "transmitPowerCdbm": 3150,
      "inventorySession": 2,
      "inventorySearchMode": "dual-target",
      "estimatedTagPopulation": 32,
      "rfMode": 1210
    }
  ]
}
```

Repeat for ports 1–4 (or only the ports with connected antennas).

---

## Antenna Hub

| Method | Path | Description |
|---|---|---|
| GET | `/system/antenna-hub` | Antenna hub status |
| PUT | `/system/antenna-hub/enable` | Enable hub |
| PUT | `/system/antenna-hub/disable` | Disable hub |

Returns `{ "status": "Disabled" }` when no hub is attached.
When enabled returns `{ "status": "Enabled", "antennaStates": [...] }`.

Note: The antenna hub is an optional accessory. Antennas connected directly to R700 ports (1–4) are **not** reported via this endpoint.

---

## MQTT event format (published by reader to broker)

Topic: configured `eventTopic` field (e.g. `leszyrun`)

The reader publishes RFID reads as JSON to the configured `eventTopic`. LeszyRun's Mosquitto subscriber listens on `leszyrun/#` (all subtopics).

---

## Notes

- `additionalProperties: false` is enforced on all PUT bodies — unknown fields cause HTTP 400
- `active: true` must be set in the MQTT config PUT for the connection to actually establish
- Firmware 7.4+ requires HTTPS
- `workState` field does **not** exist — use `status` field from `/status` endpoint
- `/system/status` does **not** exist — correct path is `/status`
- `/system/antennas` does **not** exist — correct path is `/system/antenna-hub`
