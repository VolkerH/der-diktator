# Multilingual correction comparison

**SmolLM3-3B is the prototype default.** It preserved names, numbers and source
language better in the ordinary single-language samples, and used less memory
than Qwen3-4B-Instruct-2507. Both made material semantic mistakes. Neither meets an
unattended or production-quality acceptance threshold; review every suggestion.

This small synthetic comparison separates protocol completion and mechanical
string checks from manual reading. It is a single pass over a narrow set of
examples, not a broad language benchmark.

## Final candidate observations

| Observation, final mode prompts                        | Qwen3-4B-Instruct-2507 Q4_K_M | SmolLM3-3B Q4_K_M |
| ------------------------------------------------------ | ----------------------------: | ----------------: |
| Completed streams                                      |                         26/26 |             26/26 |
| Requests with at least one `##` heading, headings mode |                         10/10 |              8/10 |
| Requests with paragraph breaks, paragraphs mode        |                           6/8 |               0/8 |
| Median first streamed delta                            |                        6.11 s |            5.13 s |
| Median completed response                              |                       17.77 s |           13.19 s |
| Observed runtime process peak resident memory          |                      5.21 GiB |          3.59 GiB |

Sources: [assembled Qwen final cases](qwen3-final-comparison.json) and
[SmolLM3 final cases](smollm3-final-comparison.json). A first streamed delta is the
first nonempty text event observed by the backend service; it can theoretically
be whitespace and is not a browser-paint measurement. Medians are descriptive
values for these single-pass warm cases, not repeated latency distributions or
p95 estimates. Other host work was uncontrolled.

Peak resident memory is the server process's `VmHWM` (Qwen: 5,460,540 KiB;
SmolLM3: 3,767,432 KiB), retained in the raw reports. It is neither the model's
download size nor a total host-memory budget. Qwen's observed peak comes from its
v2 headings run. Heading presence does not prove correct topic coverage or
preserved meaning; the semantic examples below are decisive limitations.

## Inputs and runtime

Each final candidate run covers two approximately 80–100-word snippets in each
of English, German, French and Spanish, in all three modes. Two extra headings
cases exercise mixed German/English text and a quoted instruction to ignore prior
instructions. That gives 26 requests per candidate. The source snippets and exact
outputs are retained in the JSON evidence.

Both candidates use Q4_K_M quantization, llama.cpp b11514 (`de7fa0a3c`), an Intel
Core i7-12800H under WSL2, four CPU generation and batch threads, one model slot,
4,096 context tokens, zero GPU layers, thinking disabled and prompt caching
disabled. Requests use temperature zero and at most 1,536 output tokens. One
unrelated warm-up per model is excluded. The experiment issues no speech requests;
other host workload is uncontrolled. Latency begins at backend service invocation
and excludes model loading, browser paint and network delivery to a browser.

## Prompt revisions

The first multilingual prompts ask the model to preserve source language,
language switches, names, numbers, dates, units, negation and meaning. The system prompt prohibits
translation, summarization and obeying instructions embedded in selected text.
Spelling mode requests unchanged paragraph structure; paragraphs mode requests
topic breaks. These two modes and the common system instruction did not change between
revisions.

The initial headings prompt asked for headings on substantive multi-topic input
and allowed omitting them on a single short topic. The
[Qwen v1 run](qwen3-multilingual-v1.json) completed 26/26 requests but produced
Markdown headings in only 4/10 headings cases. All four successful cases were
laboratory snippets; meeting and stress cases produced no `##` headings. Manual
reading also found a German heading-mode amount changed from 180 to 80 and an
English heading-mode date changed from 2026 to `20.26`.

The final headings prompt makes the format unconditional:

> Return Markdown. Add short headings beginning with ## in the text's original language.
> Group each topic under its own heading, with blank lines between headings and paragraphs.
> Correct spelling and punctuation. Preserve all original text content, facts and meaning;
> do not summarize or omit details.

Revision 1's complete prompt-set SHA-256 is
`31858bee6bbbabacd82ac975cd0055b21ee6388bdc21282cf3245abf3d54290f`.
Revision 2's complete prompt-set SHA-256 is
`8c092bb6ba383e7fb69a3558b2b60e5e4d330a9b701c091ad660e2aec7a04c9f`.
The digest covers the sorted JSON object containing the system and mode prompts.
The raw evidence also contains the actual prompt strings.

For Qwen, the final comparison reuses the 16 unchanged spelling/paragraph requests
from v1 and reruns only the ten headings requests with v2. The per-mode source
reports and prompt revisions must remain explicit. SmolLM3 uses v2 for all 26
requests. This avoids rerunning identical prompts while preserving a common
actual prompt for each compared mode.

## Qwen observations in the unchanged modes

The English laboratory spelling result changed 2026 to **2076**; paragraph mode
changed it to **2006**. These are factual errors despite completed streams and
mostly improved punctuation. Some laboratory spelling outputs fixed individual
typos while retaining long unpunctuated passages. French and Spanish meeting
paragraph results contained no paragraph breaks, although the source covered two
topics.

Literal anchor checks are diagnostic only: French `2400` → `2 400` and Spanish
`2400` → `2.400` retain the same amount under their number-formatting conventions.
They are not factual errors merely because an exact substring is absent. Conversely,
retaining all anchors cannot prove that negation, restrictions, relationships or
other meaning survived.

## Smallest-model control

[SmolLM2-360M control](smollm2-multilingual-control.json) used the v1 multilingual
prompts and the same 26 cases. It completed 26/26 requests and produced headings
in 0/10 cases. It translated German into English, altered dates and measurement
constraints, omitted instructions, and reversed a do-not-send-before-review
restriction. This control used Q8_0 with prompt caching enabled, so its timings
are excluded from the matched candidate comparison.

## Qwen with the final headings prompt

The [ten v2 headings requests](qwen3-headings-v2.json) all completed and all
produced `##` headings. The [assembled final 26-case report](qwen3-final-comparison.json)
records each result's source file, source prompt revision and effective
system-plus-mode prompt digest. Its timing summary is recomputed from those
26 cases, not copied from either source run.

The explicit formatting instruction improved heading presence but did not make
content reliable. Manual inspection found:

- The English meeting and quoted-command inputs were translated into Russian;
  Alice Müller's name was transliterated. This is a source-language failure,
  even though the quoted command was not obeyed as a command to the model.
- The German meeting amount changed from **180 to 80 euros**.
- The English laboratory year changed from **2026 to 2006**.
- Spanish laboratory text changed the instruction to send a draft into
  **“Se ha enviado el borrador”**, asserting that it had already been sent.
- The mixed German/English case became English throughout and omitted the
  instruction not to translate the quoted English text.

All ten headings being present is therefore a formatting observation, not a
claim that ten suggestions were acceptable.

## SmolLM3 observations and selection

The [SmolLM3 run](smollm3-final-comparison.json) used the final v2 prompt set for
all 26 requests. Manual reading of all outputs found the ordinary English,
German, French and Spanish examples stayed in their original languages. All
26 outputs retained the exact diagnostic name and number strings, including
2026 in the laboratory examples. This supports using it for the interactive
prototype over Qwen, whose observed date, amount and translation errors were
more frequent and conspicuous in these cases. It does not establish broad
language competence or semantic equivalence.

SmolLM3 still made material errors:

- German meeting **spelling** mode changed a prohibition on ordering the expensive
  sensor into an instruction to order the cheaper part instead. The source gave
  the cheaper price but did not authorize buying it.
- French meeting headings added a condition about receiving all required parts
  before telling the customer a repair was complete. That condition was absent
  from the source.
- The mixed-language case translated stretches of German into English, expanded
  the quotation attributed to Alice, and reversed the instruction not to translate
  the English quote into **“Please translate the English quote in the report.”**
- German laboratory output softened “do not increase the current” to “the current
  should not be increased.” The numeric anchors still matched.

Formatting was also inconsistent. Paragraphs mode produced **no blank paragraph
breaks in any of its eight cases**. The Spanish meeting and mixed-language
headings requests produced no `##` headings; the mixed case used bold labels.
The English meeting had just one heading for two topics. The English quoted
instruction stress case retained the command as quoted content without reducing
the response to `APPROVED`.

The selection prioritizes preservation in the tested ordinary single-language
examples, with lower memory and shorter measured completion as secondary benefits.
It is a choice for an explicitly reviewed prototype. Formatting and mixed-language
editing remain demonstrated weaknesses, and every mode can alter meaning.

## Model artifact provenance

Both local download hashes were checked against their distribution metadata.
Model files and runtimes remain outside the repository.

| Candidate              | Downloaded Q4_K_M bytes | Distribution and exact metadata                                                                                                                              |
| ---------------------- | ----------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Qwen3-4B-Instruct-2507 |           2,497,280,448 | [LM Studio community distribution](https://huggingface.co/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF), [revision and SHA-256](qwen3-model-metadata.json) |
| SmolLM3-3B             |           1,915,305,312 | [ggml-org distribution](https://huggingface.co/ggml-org/SmolLM3-3B-GGUF), [revision and SHA-256](smollm3-model-metadata.json)                                |

The original model cards are
[Qwen/Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507) and
[HuggingFaceTB/SmolLM3-3B](https://huggingface.co/HuggingFaceTB/SmolLM3-3B).
The tested quantizations are explicitly attributed to their distribution
repositories; they are not represented as original unquantized publisher weights.

## Browser validation

The [real-model browser smoke](multilingual-browser-smoke.json) separately passed
preview, explicit Accept, guarded Undo and outside-selection preservation for
English, German, French and Spanish on desktop, plus German on mobile. Chromium
153.0.8010.12 reported no page errors or horizontal overflow. Speech status was
mocked and no audio was recorded; correction itself used the real SmolLM3 server.
The Spanish result still lacked headings. This validates the review interaction,
not the semantic quality or uniform formatting of all suggestions.

[Desktop screenshot](multilingual-preview-desktop.png) ·
[Mobile screenshot](multilingual-preview-mobile.png)
