---
prompt: Build me a tip calculator app
expect: visual
synthetic: true
---
Here is a compact calculator.

```sds-genui
id: tip-calc
kind: html-app
title: Tip calculator
revision: 1
---
<main><h1>Tip</h1><input id="a" type="number"><output id="o"></output></main>
<script>a.oninput=()=>o.textContent=(a.value*0.15).toFixed(2)</script>
```
