---
"@johnhenry/aimatey-frontend": patch
---

`LayaAnswer.action` is renamed `rl_agent`, matching the name a live `@receptron/laya` response uses (the `act_probability` shape is unchanged). The field is optional and `fromIR` never sets it.
