---
"@johnhenry/aimatey-native-laya": patch
---

Declare `decisionLimits.maxConcurrency: 1` (one ONNX session), so `Bridge.decideBatch` runs sequentially by default.
