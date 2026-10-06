---
"@johnhenry/aimatey-testing": minor
---

Decision dataset capture: `createDecisionCapture({ sink, includeState?, redact? })` records every `Bridge.decide()` as JSONL (state, questions, answers, model, usage, warnings) and `recordOutcome(requestId, truth)` appends ground truth, joined on read. Also `loadDecisionDataset(path)`, `toCalibrationRuns(records)`, and memory/file sinks. This is the capture half of a fine-tuning loop; nothing here trains.
