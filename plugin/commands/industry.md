---
description: Industry report from the Reddit communities where its customers talk, with an Invest, Watch or Avoid verdict
allowed-tools: mcp__plugin_reddit-sentiment_reddit
argument-hint: "<industry> [days]"
---

Write an industry report. Load the `reddit-sentiment:sentiment-report` skill and follow it in industry mode.

Request: $ARGUMENTS

The industry is the request without a trailing number. A trailing number from 1 to 365 is the window in days, otherwise 30. If no industry is named, ask for one and stop.
