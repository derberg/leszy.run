# Impinj R700 REST API — MQTT Configuration

**Endpoint:** `PUT /api/v1/mqtt`
**Auth:** HTTP Basic (`root` / empty by default)
**Source:** OpenAPI spec v1.7 — [saji-ttarius/impinj-reader-config-api-v1.7.0](https://github.com/saji-ttarius/impinj-reader-config-api-v1.7.0) (auto-generated from official Impinj spec)
**Official spec (login required):** https://support.impinj.com/hc/en-us/articles/32195454977555-Impinj-IoT-Device-Interface-API-OpenAPI-Spec

---

## Schema: `MqttConfiguration`

The endpoint enforces `additionalProperties: false` — unknown fields cause HTTP 400.

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `brokerHostname` | string | **YES** | — | length 1–253 |
| `clientId` | string | **YES** | — | length 1–23, pattern `^[a-zA-Z0-9]+$` (alphanumeric only, no hyphens/underscores) |
| `eventTopic` | string | **YES** | — | length 1–200, pattern `^[^#+]*$` (no `#` or `+`) |
| `active` | boolean | no | `false` | Must be `true` for MQTT to actually connect |
| `brokerPort` | integer | no | — | 1–65535 |
| `cleanSession` | boolean | no | `false` | Remove subscription state on disconnect |
| `eventBufferSize` | integer | no | — | 1000–300000 |
| `eventPerSecondLimit` | integer | no | — | 0–100000 (0 = no limit) |
| `eventPendingDeliveryLimit` | integer | no | — | 10–10000 |
| `eventQualityOfService` | integer | no | — | 0=at most once, 1=at least once, 2=exactly once |
| `keepAliveIntervalSeconds` | integer | no | — | 0–65535 |
| `tlsEnabled` | boolean | no | `false` | |
| `username` | string | no | `""` | length 0–200 |
| `password` | string | no | `""` | length 0–200 |
| `willTopic` | string | no | `""` | length 0–200, pattern `^[^#+]*$` |
| `willMessage` | string | no | `"connection lost"` | length 0–500 |
| `willQualityOfService` | integer | no | — | 0–2 |
| `connectMessage` | string | no | `"connected"` | length 0–500 |
| `disconnectMessage` | string | no | `""` | length 0–500 |

### Common mistakes (wrong field names from other docs/guesses)

| Wrong name | Correct name |
|---|---|
| `qos` | `eventQualityOfService` |
| `keepAliveSeconds` | `keepAliveIntervalSeconds` |
| `cleanSessionOnDisconnect` | `cleanSession` |
| `topicPrefix` | `eventTopic` |
| `retainPublished` | (not a valid field) |

### Minimal working example

```json
{
  "brokerHostname": "169.254.1.1",
  "brokerPort": 1883,
  "clientId": "LeszyRunMain",
  "eventTopic": "leszyrun",
  "active": true,
  "tlsEnabled": false
}
```

### Read current config

```bash
curl -u root: -k https://<reader-ip>/api/v1/mqtt
```
