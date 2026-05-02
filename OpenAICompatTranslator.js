const thisAddon = this;
const OpenAI = require("www/modules/openai/OpenAI.js");
const libGPT = require("www/js/LibGpt.js");

const PROVIDER_PRESETS = {
    lmstudio: {
        label: "LM Studio",
        baseURL: "http://localhost:1234/v1",
        apiKey: "lm-studio",
        model: "local-model",
        needsApiKey: false
    },
    openai: {
        label: "OpenAI",
        baseURL: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4.1-mini",
        needsApiKey: true
    },
    deepseek: {
        label: "DeepSeek",
        baseURL: "https://api.deepseek.com",
        apiKey: "",
        model: "deepseek-chat",
        needsApiKey: true
    },
    gemini: {
        label: "Gemini",
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        apiKey: "",
        model: "gemini-3-flash-preview",
        needsApiKey: true
    },
    kimi: {
        label: "Kimi",
        baseURL: "https://api.moonshot.ai/v1",
        apiKey: "",
        model: "kimi-k2.6",
        needsApiKey: true
    },
    custom: {
        label: "Custom",
        baseURL: "",
        apiKey: "",
        model: "",
        needsApiKey: false
    }
};

const defaultConfig = {
    provider: "lmstudio",
    baseUrl: PROVIDER_PRESETS.lmstudio.baseURL,
    apiKey: PROVIDER_PRESETS.lmstudio.apiKey,
    model: PROVIDER_PRESETS.lmstudio.model,
    systemPromptTemplate: [
        "You are an expert video game localization engine.",
        "Translate from ${LANG_FROM_FULL} to ${LANG_TO_FULL}.",
        "Project title: ${TITLE}.",
        "Game engine: ${ENGINE}.",
        "Target domain: RPG Maker, Wolf RPG, Ren'Py, visual novels, JRPG dialogue, UI, item names, quest text, and flavor text.",
        "Requirements:",
        "- Return only valid JSON.",
        "- Preserve row count and row order exactly.",
        "- Preserve placeholders, escape codes, variables, markup, tags, control codes, and line break semantics.",
        "- Preserve the tone, character voice, and narrative intent.",
        "- Do not explain choices.",
        "- Do not censor mild game content unless the source already softens it.",
        "- Keep honorifics, proper nouns, recurring terminology, and gameplay terms consistent.",
        "- Resolve omitted subjects and pronouns from nearby context, speaker hints, and project knowledge.",
        "- If a glossary entry applies, follow it unless it would break grammar around placeholders.",
        "- If a row is blank or only placeholder content, keep it aligned and minimally changed.",
        "",
        "Engine-specific preservation rules:",
        "${ENGINE_RULES_BLOCK}"
    ].join("\n"),
    userPromptTemplate: [
        "Translate the JSON array of source rows below.",
        "Return a JSON object in this exact format: {\"translations\":[\"string1\", \"string2\", ...]}",
        "CRITICAL: The `translations` array MUST have exactly the same number of elements as the input array.",
        "CRITICAL: Do NOT combine multiple translations into a single string. Each input string MUST get exactly one separate output string in the array.",
        "Preserve placeholders exactly as written, including case and brackets.",
        "Use the glossary, row hints, project knowledge, and recent context when helpful.",
        "",
        "Project metadata:",
        "- Title: ${TITLE}",
        "- Engine: ${ENGINE}",
        "- Language pair: ${LANG_FROM_FULL} -> ${LANG_TO_FULL}",
        "- Batch strategy: ${BATCH_STRATEGY_BLOCK}",
        "",
        "Glossary:",
        "${GLOSSARY_BLOCK}",
        "",
        "Project knowledge:",
        "${PROJECT_KNOWLEDGE_BLOCK}",
        "",
        "Per-row context hints:",
        "${ROW_CONTEXT_BLOCK}",
        "",
        "Additional context:",
        "${EXTRA_CONTEXT_BLOCK}",
        "",
        "Recent context window:",
        "${HISTORY_BLOCK}",
        "",
        "Source rows JSON:",
        "${SOURCE_JSON}"
    ].join("\n"),
    glossaryText: "",
    extraContext: "",
    includeProjectMetadata: true,
    autoBuildProjectKnowledge: true,
    contextMode: "balanced",
    maxContextHints: 2,
    projectKnowledgeBudget: 1200,
    useSlidingWindow: true,
    slidingWindowSize: 8,
    historyCharBudget: 2200,
    maxTokens: 1800,
    temperature: 0.2,
    top_p: 1,
    reasoningEffort: "",
    thinkingMode: "auto",
    extraBodyJson: "",
    connectionTestPrompt: "Reply only with: OK",
    activePreset: "custom",
    availableModelsText: "",
    contextPreviewText: "",
    batchTimeOut: 90000,
    maxRequestLength: 5000,
    maxConcurrentRequest: 1,
    rowLimitPerBatch: 6,
    batchDelay: 0,
    lineSubstitute: "<br>",
    escapeAlgorithm: "hexPlaceholder"
};

function safeJsonStringify(value, fallback) {
    try {
        return JSON.stringify(value);
    } catch (e) {
        return fallback || "[]";
    }
}

function ensureArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "undefined" || value === null) return [];
    return [value];
}

function trimArrayToLength(values, expectedLength) {
    const arr = ensureArray(values).slice(0, expectedLength);
    while (arr.length < expectedLength) arr.push("");
    return arr;
}

function stripCodeFence(text) {
    if (typeof text !== "string") return "";
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\s*/, "");
        cleaned = cleaned.replace(/```$/, "");
    }
    return cleaned.trim();
}

function extractJSONObject(text) {
    const cleaned = stripCodeFence(text);
    // Try to find a JSON block via markdown fences first to ignore conversational garbage
    const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
        return match[1].trim();
    }
    // Fallback: from first { to last }
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first < 0 || last < first) return cleaned;
    return cleaned.substring(first, last + 1);
}

function parseGlossaryText(glossaryText) {
    const entries = [];
    const lines = String(glossaryText || "").split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith("//")) continue;

        let source = "";
        let target = "";
        if (line.includes("=>")) {
            [source, target] = line.split(/=>/, 2);
        } else if (line.includes("\t")) {
            [source, target] = line.split(/\t/, 2);
        } else if (line.includes("=")) {
            [source, target] = line.split(/=/, 2);
        } else {
            continue;
        }

        source = String(source || "").trim();
        target = String(target || "").trim();
        if (!source) continue;
        entries.push({ source, target });
    }
    return entries;
}

function renderGlossary(entries) {
    if (!entries.length) return "(none)";
    return entries.map((entry) => `- ${entry.source} => ${entry.target}`).join("\n");
}

function copyLeadingWhitespace(source, translated) {
    if (typeof source !== "string" || typeof translated !== "string") return translated;
    return common.copyStartingWhiteSpaces(source, translated);
}

function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of ensureArray(values)) {
        const normalized = String(value || "").trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function shortenText(text, maxLength) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!maxLength || normalized.length <= maxLength) return normalized;
    return normalized.substring(0, Math.max(0, maxLength - 3)) + "...";
}

function normalizePathForCompare(filePath) {
    return String(filePath || "").replace(/\\/g, "/").toLowerCase();
}

function basenameFromPath(filePath) {
    return String(filePath || "").split(/[\\/]/).pop() || "";
}

function parseLooseJsonObject(text, fallbackValue) {
    const raw = String(text || "").trim();
    if (!raw) return fallbackValue;
    try {
        return JSON.parse(raw);
    } catch (e) {
        try {
            return JSON.parse(raw.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]"));
        } catch (e2) {
            return fallbackValue;
        }
    }
}

function normalizeParameterObjects(parameterEntries) {
    const result = [];
    for (const entry of ensureArray(parameterEntries)) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            result.push(entry);
        }
    }
    return result;
}

function collectRowInfoTexts(parameterEntries) {
    const result = [];
    for (const entry of normalizeParameterObjects(parameterEntries)) {
        if (!entry.rowInfoText) continue;
        result.push(String(entry.rowInfoText));
    }
    return uniqueStrings(result);
}

function normalizeMessageContent(message) {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === "string") return part;
            if (typeof part?.text === "string") return part.text;
            return "";
        }).join("");
    }
    return "";
}

function looksLikePlaceholderOnly(text) {
    const normalized = String(text || "").trim();
    if (!normalized) return true;
    const stripped = normalized
        .replace(/\\\\[A-Za-z!><^$.\|\{\}\\]+(?:\[[^\]]*\])?/g, "")
        .replace(/<[^>\n]+>/g, "")
        .replace(/\{[^{}\n]+\}/g, "")
        .replace(/[%\[\]\(\)\{\}\d\s:;,.!?'"`~@#&*_+=\/\\|-]+/g, "");
    return stripped.length === 0;
}

function isGoodGlossaryCandidate(text) {
    const normalized = String(text || "").trim();
    if (!normalized) return false;
    
    // Filter out typical RPG Maker technical IDs and script patterns (EV001, Map001, e319, h126, etc.)
    if (/^(EV|Map|MapInfos|e|h|hc|p|e\d+|#DNG#|p\d+)\d*$/i.test(normalized)) return false;
    if (/^[a-z]\d+.*$/i.test(normalized) && normalized.length < 12) {
        // Excludes e319, h126, etc. but allows longer descriptive text
        if (!/\s/.test(normalized)) return false;
    }
    
    // Filter out technical strings with mixed letters/numbers and no spaces (likely IDs or codes)
    if (/^[A-Za-z0-9_-]+$/.test(normalized) && /\d/.test(normalized) && /[A-Za-z]/.test(normalized)) {
        if (normalized.length < 15) return false;
    }

    // Filter out common technical labels
    const technicalLabels = ["yes", "no", "ok", "cancel", "true", "false", "on", "off", "none", "null", "undefined", "select"];
    if (technicalLabels.includes(normalized.toLowerCase())) return false;
    if (normalized.length < 2 || normalized.length > 80) return false;

    // Filter out short bracketed IDs
    if (/^\[.{1,8}\]$/.test(normalized)) return false;

    if (normalized.includes("\n")) return false;
    if (looksLikePlaceholderOnly(normalized)) return false;
    
    const hasLetters = /\p{L}/u.test(normalized);
    if (!hasLetters) return false;

    return true;
}




function buildGlossarySection(title, values, duplicateValue) {
    const cleaned = uniqueStrings(values).filter(isGoodGlossaryCandidate);
    if (!cleaned.length) return "";
    const lines = [`# ${title}`];
    for (const value of cleaned) {
        lines.push(`${value} => ${duplicateValue ? value : ""}`.trimEnd());
    }
    return lines.join("\n");
}

function maskPatterns(text) {
    const mapping = [];
    const rules = [
        /\\\\[A-Za-z!><^$.\|\{\}\\]+(?:\[[^\]]*\])?/g,
        /%(\d+\$)?[sdif]/g,
        /\{\{[^{}]+\}\}/g,
        /<[^>\n]+>/g,
        /\[[A-Z_]+\d+\]/g
    ];

    let protectedText = String(text || "");
    let counter = 0;

    const registerToken = (match) => {
        const token = `__TPP_TOKEN_${counter}__`;
        counter += 1;
        mapping.push({ token, value: match });
        return token;
    };

    for (const rule of rules) {
        protectedText = protectedText.replace(rule, registerToken);
    }

    return {
        text: protectedText,
        mapping
    };
}

function unmaskPatterns(text, mapping) {
    let result = String(text || "");
    for (const entry of mapping || []) {
        result = result.split(entry.token).join(entry.value);
    }
    return result;
}

function parseJsonTranslations(rawText, expectedLength, throwOnFail = false) {
    const jsonCandidate = extractJSONObject(rawText);
    let parsed;
    let jsonError = null;
    try {
        parsed = JSON.parse(jsonCandidate);
    } catch (e) {
        parsed = null;
        jsonError = e;
    }

    let translations = [];
    if (parsed?.translations && Array.isArray(parsed.translations)) {
        translations = parsed.translations;
    } else if (parsed?.translation && Array.isArray(parsed.translation)) {
        translations = parsed.translation;
    } else if (parsed?.data && Array.isArray(parsed.data)) {
        translations = parsed.data;
    }

    if (!translations.length) {
        // Safe fallback: if it looks like broken JSON, do NOT inject raw syntax into the game
        if (rawText.includes("```json") || rawText.includes("{")) {
             translations = [];
        } else {
             const fallbackRows = stripCodeFence(rawText).split(/\r?\n/);
             translations = fallbackRows.filter((line) => line.trim() !== "");
        }
    }

    // --- SELF-HEALING FOR LOCAL LLMS ---
    // If the model grouped all items into a single string separated by \n
    if (translations.length === 1 && expectedLength > 1 && typeof translations[0] === "string") {
        const splitAttempt = translations[0].split(/\r?\n/).filter(line => line.trim() !== "");
        // Only accept the split if it actually found multiple items
        if (splitAttempt.length > 1) {
            translations = splitAttempt;
        }
    }

    if (throwOnFail) {
        if (!parsed) throw new Error("Invalid JSON syntax generated by AI: " + (jsonError?.message || ""));
        if (translations.length < expectedLength) throw new Error(`Missing translations. Expected ${expectedLength}, got ${translations.length}`);
    }

    return trimArrayToLength(translations, expectedLength);
}

function buildHistorySnippet(historyPairs, maxItems, charBudget) {
    if (!historyPairs.length || maxItems < 1 || charBudget < 1) return "(none)";
    const selected = historyPairs.slice(-maxItems);
    const lines = [];
    let remaining = charBudget;
    for (const pair of selected) {
        const line = `- ${safeJsonStringify(pair.source, "\"\"")} => ${safeJsonStringify(pair.translation, "\"\"")}`;
        if (line.length > remaining) break;
        lines.push(line);
        remaining -= line.length;
    }
    return lines.length ? lines.join("\n") : "(none)";
}

function buildProjectMetadataBlock() {
    const project = trans.project || {};
    const title = project.gameTitle || project.title || "";
    const engine = project.gameEngine || "";
    return {
        TITLE: title || "(unknown title)",
        ENGINE: engine || "(unknown engine)"
    };
}

function getProviderPreset(providerId) {
    return PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.custom;
}

function classifyOccurrence(filePath, contexts, parameterEntries) {
    const normalizedPath = normalizePathForCompare(filePath);
    const fileName = basenameFromPath(normalizedPath);
    const contextBlob = uniqueStrings(contexts).join(" | ").toLowerCase();
    const rowInfoTexts = collectRowInfoTexts(parameterEntries);

    if (rowInfoTexts.length && (contextBlob.includes("message") || contextBlob.includes("dialog") || contextBlob.includes("cmd"))) {
        return "speakered_dialogue";
    }
    if (contextBlob.includes("choice")) return "choice";
    if (contextBlob.includes("message") || contextBlob.includes("show text") || contextBlob.includes("scrollingmessage")) return "dialogue";
    if (contextBlob.includes("comment")) return "comment";
    if (contextBlob.includes("actorname")) return "actor_name";
    if (contextBlob.includes("map")) return "location";
    if (fileName === "actors.json") return "actor";
    if (fileName === "mapinfos.json") return "location";
    if (["skills.json", "states.json", "items.json", "weapons.json", "armors.json"].includes(fileName)) return "term";
    if (["classes.json", "enemies.json", "troops.json", "commonevents.json", "system.json"].includes(fileName)) return "system_term";
    if (normalizedPath.includes("/tl/") || normalizedPath.includes("/gui/")) return "ui";
    return "text";
}

function buildEngineRulesBlock(engineName) {
    const engine = String(engineName || "").toLowerCase();
    if (engine.includes("rmmv") || engine.includes("rmmz") || engine.includes("rpgmaker")) {
        return [
            "- Preserve RPG Maker control codes such as \\N[n], \\V[n], \\P[n], \\G, \\C[n], \\I[n], \\{, \\}, \\$, \\\\, \\!, \\>, \\<, \\^, and percent placeholders.",
            "- Map and event dialogue often omits subjects; infer them from adjacent rows and speaker hints.",
            "- Names, maps, skills, classes, states, items, and system terms often come from separate database files; keep them consistent with project knowledge."
        ].join("\n");
    }
    if (engine.includes("renpy")) {
        return [
            "- Preserve Ren'Py tags and substitutions such as [var], [var!t], {w}, {p}, {nw}, {fast}, {i}, {b}, {size=}, and {#context}.",
            "- Dialogue may be tied to Character definitions and monologue blocks; preserve line grouping and tone continuity.",
            "- Treat speaker symbols and visible name strings as strong hints for pronouns, register, and intimacy."
        ].join("\n");
    }
    if (engine.includes("wolf")) {
        return [
            "- Preserve WOLF RPG style and control codes such as \\c[n], \\n[n], and similar inline syntax exactly.",
            "- Event text is often fragmented across command lists; use nearby row hints to restore omitted subjects and scene flow.",
            "- Common events, map events, and event names may carry gameplay meaning; keep terminology stable."
        ].join("\n");
    }
    return [
        "- Preserve placeholders, escapes, variables, and inline tags exactly.",
        "- Use nearby row hints and project knowledge to resolve omitted subjects and pronouns."
    ].join("\n");
}

const thisEngine = new TranslatorEngine({
    id: thisAddon.package.name,
    name: thisAddon.package.title,
    description: thisAddon.package.description,
    author: "Codex",
    version: thisAddon.package.version,
    delimiter: "\n\n",
    lineSubstitute: defaultConfig.lineSubstitute,
    mode: "rowByRow",
    batchTimeOut: defaultConfig.batchTimeOut,
    batchDelay: defaultConfig.batchDelay,
    maxRequestLength: defaultConfig.maxRequestLength,
    rowLimitPerBatch: defaultConfig.rowLimitPerBatch,
    escapeAlgorithm: defaultConfig.escapeAlgorithm,
    enableOptionManager: true,
    languages: langTools.getLanguageList(["auto"]),
    optionsForm: {
        schema: {
            provider: {
                type: "string",
                title: "Provider",
                description: "Choose a preset for LM Studio or an external OpenAI-compatible API.",
                default: defaultConfig.provider,
                enum: Object.keys(PROVIDER_PRESETS)
            },
            baseUrl: {
                type: "string",
                title: "Base URL",
                description: "OpenAI-compatible base URL.",
                default: defaultConfig.baseUrl,
                required: true
            },
            apiKey: {
                type: "string",
                title: "API Key",
                description: "Use a real key for cloud providers. LM Studio can work with a dummy key.",
                default: defaultConfig.apiKey,
                required: false
            },
            model: {
                type: "string",
                title: "Model",
                description: "Model identifier for the selected provider.",
                default: defaultConfig.model,
                required: true,
                enum: []
            },
            activePreset: {
                type: "string",
                title: "Active Preset",
                description: "Currently applied performance preset.",
                default: defaultConfig.activePreset,
                readOnly: true
            },
            availableModelsText: {
                type: "string",
                title: "Discovered Models",
                description: "Copyable list of models returned by /v1/models.",
                default: defaultConfig.availableModelsText,
                readOnly: true
            },
            includeProjectMetadata: {
                type: "boolean",
                title: "Include Project Metadata",
                description: "Inject project title and engine into the prompt.",
                default: defaultConfig.includeProjectMetadata
            },
            autoBuildProjectKnowledge: {
                type: "boolean",
                title: "Auto Project Knowledge",
                description: "Harvest names, locations, items, and speaker hints from the loaded project.",
                default: defaultConfig.autoBuildProjectKnowledge
            },
            contextMode: {
                type: "string",
                title: "Context Mode",
                description: "Use lightweight or balanced context so batch translation stays fast.",
                default: defaultConfig.contextMode,
                enum: ["off", "light", "balanced"]
            },
            maxContextHints: {
                type: "number",
                title: "Max Context Hints Per Row",
                description: "How many project occurrences to consult per source row.",
                default: defaultConfig.maxContextHints,
                minimum: 0,
                maximum: 8
            },
            projectKnowledgeBudget: {
                type: "number",
                title: "Project Knowledge Budget",
                description: "Character budget for harvested project knowledge.",
                default: defaultConfig.projectKnowledgeBudget,
                minimum: 0,
                maximum: 10000
            },
            glossaryText: {
                type: "string",
                title: "Glossary",
                description: "One entry per line using =>, =, or tab.",
                default: defaultConfig.glossaryText
            },
            extraContext: {
                type: "string",
                title: "Extra Context",
                description: "Character notes, setting, tone guides, banned translations, and romanization rules.",
                default: defaultConfig.extraContext
            },
            systemPromptTemplate: {
                type: "string",
                title: "System Prompt Template",
                description: "High-level behavior and hard rules.",
                default: defaultConfig.systemPromptTemplate,
                required: true
            },
            userPromptTemplate: {
                type: "string",
                title: "User Prompt Template",
                description: "Per-request instruction template.",
                default: defaultConfig.userPromptTemplate,
                required: true
            },
            useSlidingWindow: {
                type: "boolean",
                title: "Use Sliding Window Context",
                description: "Carry short-term memory from recent translated rows.",
                default: defaultConfig.useSlidingWindow
            },
            autoCleanGlossary: {
                type: "boolean",
                title: "Auto-clean Glossary",
                description: "Automatically run AI filtering after scanning project glossary.",
                default: false
            },
            contextNeighborhoodSize: {
                type: "number",
                title: "Context Neighborhood Size",
                description: "How many lines before and after to include as dialogue context.",
                default: 3,
                minimum: 0,
                maximum: 10
            },
            slidingWindowSize: {
                type: "number",
                title: "Sliding Window Size",
                description: "How many recent pairs to include as memory.",
                default: defaultConfig.slidingWindowSize,
                minimum: 0,
                maximum: 50
            },
            historyCharBudget: {
                type: "number",
                title: "History Char Budget",
                description: "Maximum history snippet size inserted into the prompt.",
                default: defaultConfig.historyCharBudget,
                minimum: 0,
                maximum: 20000
            },
            maxTokens: {
                type: "number",
                title: "Max Output Tokens",
                description: "Maximum output token budget for each request.",
                default: defaultConfig.maxTokens,
                minimum: 64,
                maximum: 32768
            },
            temperature: {
                type: "number",
                title: "Temperature",
                description: "Lower values are usually safer for localization consistency.",
                default: defaultConfig.temperature,
                minimum: 0,
                maximum: 2
            },
            top_p: {
                type: "number",
                title: "Top P",
                description: "Nucleus sampling parameter.",
                default: defaultConfig.top_p,
                minimum: 0,
                maximum: 1
            },
            reasoningEffort: {
                type: "string",
                title: "Reasoning Effort",
                description: "Optional OpenAI-compatible reasoning setting.",
                default: defaultConfig.reasoningEffort,
                enum: ["", "none", "minimal", "low", "medium", "high"]
            },
            thinkingMode: {
                type: "string",
                title: "Thinking Mode",
                description: "Provider-specific thinking toggle. Especially useful for Kimi K2.6.",
                default: defaultConfig.thinkingMode,
                enum: ["auto", "enabled", "disabled"]
            },
            extraBodyJson: {
                type: "string",
                title: "Extra Body JSON",
                description: "Optional raw JSON merged into the chat completions body.",
                default: defaultConfig.extraBodyJson
            },
            connectionTestPrompt: {
                type: "string",
                title: "Connection Test Prompt",
                description: "Short prompt used by the connection tester.",
                default: defaultConfig.connectionTestPrompt
            },
            contextPreviewText: {
                type: "string",
                title: "Context Preview",
                description: "Preview of harvested project knowledge and row hints.",
                default: defaultConfig.contextPreviewText,
                readOnly: true
            },
            batchTimeOut: {
                type: "number",
                title: "Batch Timeout",
                description: "Timeout per batch in milliseconds.",
                default: defaultConfig.batchTimeOut
            },
            maxRequestLength: {
                type: "number",
                title: "Max Request Length",
                description: "Character limit per batch before Translator++ splits requests.",
                default: defaultConfig.maxRequestLength
            },
            maxConcurrentRequest: {
                type: "number",
                title: "Max Concurrent Requests",
                description: "Use 0 or 1 when sliding context is enabled.",
                default: defaultConfig.maxConcurrentRequest,
                minimum: 0,
                maximum: 50
            },
            rowLimitPerBatch: {
                type: "number",
                title: "Rows Per Batch",
                description: "How many rows are translated together.",
                default: defaultConfig.rowLimitPerBatch,
                minimum: 0,
                maximum: 200
            },
            batchDelay: {
                type: "number",
                title: "Batch Delay",
                description: "Delay between requests in milliseconds.",
                default: defaultConfig.batchDelay
            },
            escapeAlgorithm: {
                type: "string",
                title: "Translator++ Escape Algorithm",
                description: "Additional pre-processing from Translator++ before placeholder protection runs.",
                default: defaultConfig.escapeAlgorithm,
                enum: ["", "hexPlaceholder", "JSTemplateCloaking", "HTMLCloaking", "HTMLCloakingWrapped", "XMLCloaking", "JSONCloaking", "none"]
            }
        },
        form: [
            {
                type: "advancedfieldset",
                title: "Connection",
                items: [
                    {
                        key: "provider",
                        titleMap: {
                            lmstudio: "LM Studio",
                            openai: "OpenAI",
                            deepseek: "DeepSeek",
                            gemini: "Gemini",
                            kimi: "Kimi",
                            custom: "Custom"
                        },
                        onChange: function(evt) {
                            thisEngine.applyProviderPreset($(evt.target).val(), evt.target);
                        }
                    },
                    {
                        key: "baseUrl",
                        onChange: function(evt) {
                            thisEngine.update("baseUrl", $(evt.target).val());
                            thisEngine.invalidateClient();
                        }
                    },
                    {
                        key: "apiKey",
                        onChange: function(evt) {
                            thisEngine.update("apiKey", $(evt.target).val());
                            thisEngine.invalidateClient();
                        }
                    },
                    {
                        key: "model",
                        type: "select",
                        onChange: function(evt) {
                            thisEngine.update("model", $(evt.target).val());
                        }
                    },
                    {
                        key: "activePreset",
                        readOnly: true
                    },
                    {
                        key: "availableModelsText",
                        type: "ace",
                        aceMode: "text",
                        aceTheme: "twilight",
                        width: "100%",
                        height: "120px",
                        readOnly: true
                    }
                ]
            },
            {
                type: "fieldset",
                title: "Editor de Glosario y Contexto",
                items: [
                    {
                        type: "info",
                        value: "Edita tu glosario directamente aquí (Formato: Origen => Traducción). La IA usará estos términos para mantener la consistencia."
                    },
                    {
                        key: "glossaryText",
                        type: "ace",
                        aceMode: "text",
                        aceTheme: "twilight",
                        width: "100%",
                        height: "400px",
                        onChange: function(evt) {
                            thisEngine.update("glossaryText", $(evt.target).val());
                        }
                    },
                    {
                        key: "extraContext",
                        title: "Instrucciones de Contexto (Prompt)",
                        type: "ace",
                        aceMode: "text",
                        aceTheme: "twilight",
                        width: "100%",
                        height: "150px",
                        onChange: function(evt) {
                            thisEngine.update("extraContext", $(evt.target).val());
                        }
                    }
                ]
            },
            {
                type: "advancedfieldset",
                title: "Configuración de Contexto Inteligente",
                items: [
                    {
                        type: "info",
                        value: "Ajustes del motor de cosecha de datos y vecindad de diálogos."
                    },
                    {
                        key: "includeProjectMetadata",
                        onChange: function(evt) {
                            thisEngine.update("includeProjectMetadata", $(evt.target).prop("checked"));
                        }
                    },
                    {
                        key: "autoBuildProjectKnowledge",
                        onChange: function(evt) {
                            thisEngine.update("autoBuildProjectKnowledge", $(evt.target).prop("checked"));
                            thisEngine.invalidateProjectCache();
                        }
                    },
                    {
                        key: "contextMode",
                        onChange: function(evt) {
                            thisEngine.update("contextMode", $(evt.target).val());
                        }
                    },
                    {
                        key: "maxContextHints",
                        onChange: function(evt) {
                            thisEngine.update("maxContextHints", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "projectKnowledgeBudget",
                        onChange: function(evt) {
                            thisEngine.update("projectKnowledgeBudget", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "useSlidingWindow",
                        onChange: function(evt) {
                            thisEngine.update("useSlidingWindow", $(evt.target).prop("checked"));
                        }
                    },
                    {
                        key: "slidingWindowSize",
                        onChange: function(evt) {
                            thisEngine.update("slidingWindowSize", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "contextNeighborhoodSize",
                        onChange: function(evt) {
                            thisEngine.update("contextNeighborhoodSize", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "autoCleanGlossary",
                        onChange: function(evt) {
                            thisEngine.update("autoCleanGlossary", $(evt.target).prop("checked"));
                        }
                    },
                    {
                        key: "historyCharBudget",
                        onChange: function(evt) {
                            thisEngine.update("historyCharBudget", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "contextPreviewText",
                        type: "ace",
                        aceMode: "text",
                        aceTheme: "twilight",
                        width: "100%",
                        height: "180px",
                        readOnly: true
                    }
                ]
            },

            {
                type: "advancedfieldset",
                title: "Prompts",
                items: [
                    {
                        key: "systemPromptTemplate",
                        type: "ace",
                        aceMode: "text",
                        aceTheme: "twilight",
                        width: "100%",
                        height: "220px",
                        onChange: function(evt) {
                            thisEngine.update("systemPromptTemplate", $(evt.target).val());
                        }
                    },
                    {
                        key: "userPromptTemplate",
                        type: "ace",
                        aceMode: "text",
                        aceTheme: "twilight",
                        width: "100%",
                        height: "260px",
                        onChange: function(evt) {
                            thisEngine.update("userPromptTemplate", $(evt.target).val());
                        }
                    }
                ]
            },
            {
                type: "advancedfieldset",
                title: "Advanced",
                items: [
                    {
                        key: "maxTokens",
                        onChange: function(evt) {
                            thisEngine.update("maxTokens", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "temperature",
                        type: "range",
                        step: 0.05,
                        indicator: true,
                        onChange: function(evt) {
                            thisEngine.update("temperature", parseFloat($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "top_p",
                        type: "range",
                        step: 0.05,
                        indicator: true,
                        onChange: function(evt) {
                            thisEngine.update("top_p", parseFloat($(evt.target).val() || "1"));
                        }
                    },
                    {
                        key: "reasoningEffort",
                        onChange: function(evt) {
                            thisEngine.update("reasoningEffort", $(evt.target).val());
                        }
                    },
                    {
                        key: "thinkingMode",
                        onChange: function(evt) {
                            thisEngine.update("thinkingMode", $(evt.target).val());
                        }
                    },
                    {
                        key: "extraBodyJson",
                        type: "ace",
                        aceMode: "json",
                        aceTheme: "twilight",
                        width: "100%",
                        height: "120px",
                        onChange: function(evt) {
                            thisEngine.update("extraBodyJson", $(evt.target).val());
                        }
                    },
                    {
                        key: "connectionTestPrompt",
                        onChange: function(evt) {
                            thisEngine.update("connectionTestPrompt", $(evt.target).val());
                        }
                    },
                    {
                        key: "batchTimeOut",
                        onChange: function(evt) {
                            thisEngine.update("batchTimeOut", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "maxRequestLength",
                        onChange: function(evt) {
                            thisEngine.update("maxRequestLength", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "maxConcurrentRequest",
                        onChange: function(evt) {
                            thisEngine.update("maxConcurrentRequest", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "rowLimitPerBatch",
                        onChange: function(evt) {
                            thisEngine.update("rowLimitPerBatch", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "batchDelay",
                        onChange: function(evt) {
                            thisEngine.update("batchDelay", parseInt($(evt.target).val() || "0"));
                        }
                    },
                    {
                        key: "escapeAlgorithm",
                        onChange: function(evt) {
                            thisEngine.update("escapeAlgorithm", $(evt.target).val());
                        }
                    }
                ]
            },
            {
                type: "advancedfieldset",
                title: "Tools",
                items: [
                    {
                        type: "actions",
                        items: [
                            {
                                type: "button",
                                title: "Test connection",
                                onClick: async function() {
                                    await thisEngine.testConnection();
                                }
                            },
                            {
                                type: "button",
                                title: "List models",
                                onClick: async function() {
                                    await thisEngine.showAvailableModels();
                                }
                            },
                            {
                                type: "button",
                                title: "Scan project glossary",
                                onClick: async function() {
                                    await thisEngine.scanProjectGlossary();
                                }
                            },
                            {
                                type: "button",
                                title: "Clean glossary with AI",
                                onClick: async function() {
                                    const raw = thisEngine.getOptions("glossaryText");
                                    const cleaned = await thisEngine.cleanGlossaryWithAI(raw);
                                    thisEngine.update("glossaryText", cleaned);
                                    thisEngine.syncFormValue("glossaryText", cleaned);
                                    alert("Glossary cleaned!");
                                }
                            },
                            {
                                type: "button",
                                title: "Translate glossary with AI",
                                onClick: async function() {
                                    await thisEngine.translateGlossaryWithAI();
                                }
                            },
                            {
                                type: "button",
                                title: "Export glossary",
                                onClick: async function() {
                                    await thisEngine.exportGlossary();
                                }
                            },
                            {
                                type: "button",
                                title: "Import glossary",
                                onClick: async function() {
                                    await thisEngine.importGlossary();
                                }
                            },
                            {
                                type: "button",
                                title: "Refresh context preview",
                                onClick: async function() {
                                    thisEngine.refreshContextPreview();
                                }
                            },
                            {
                                type: "button",
                                title: "Open tester",
                                onClick: async function() {
                                    thisAddon.openTesterWindow();
                                }
                            },
                            {
                                type: "button",
                                title: "Preset: Speed",
                                onClick: async function() {
                                    thisEngine.applyPerformancePreset("speed");
                                }
                            },
                            {
                                type: "button",
                                title: "Preset: Balanced",
                                onClick: async function() {
                                    thisEngine.applyPerformancePreset("balanced");
                                }
                            },
                            {
                                type: "button",
                                title: "Preset: Quality",
                                onClick: async function() {
                                    thisEngine.applyPerformancePreset("quality");
                                }
                            },
                            {
                                type: "button",
                                title: "Preset: Reasoning",
                                onClick: async function() {
                                    thisEngine.applyPerformancePreset("reasoning");
                                }
                            }
                        ]
                    }
                ]
            }
        ],
        onChange: function() {
            thisEngine.invalidateClient();
        }
    }
}, defaultConfig);

thisEngine.recentHistory = [];
thisEngine.lastClientFingerprint = "";
thisEngine.client = null;
thisEngine.projectIndex = null;
thisEngine.projectFingerprint = "";

// --- AI CONSOLE LOGGING SYSTEM ---
class AiConsole {
    constructor(engine) {
        this.engine = engine;
        this.$dialog = null;
        this.$console = null;
        this.brandColor = "#C03962";
    }

    init() {
        if ($("#ai-console-dialog").length) return;

        this.$dialog = $('<div id="ai-console-dialog" title="AI Integration Console"></div>');
        this.$console = $('<div class="ai-console-body"></div>');
        
        this.$dialog.css({ "background": "#1e1e1e", "color": "#d4d4d4", "padding": "0", "overflow": "hidden", "display": "flex", "flex-direction": "column" });
        this.$console.css({
            "flex": "1",
            "padding": "10px",
            "overflow-y": "auto",
            "font-family": "'Consolas', 'Monaco', 'Courier New', monospace",
            "font-size": "12px",
            "line-height": "1.4",
            "white-space": "pre-wrap",
            "word-wrap": "break-word",
            "background": "#1e1e1e"
        });

        const $toolbar = $('<div class="ai-console-toolbar"></div>');
        $toolbar.css({ "background": "#252526", "padding": "5px 10px", "display": "flex", "gap": "10px", "border-bottom": "1px solid #333" });

        const createAction = (label, fn) => {
            const $btn = $(`<a href="#" style="color:#aaa; text-decoration:none; font-size:11px; transition:color 0.2s;">${label}</a>`);
            $btn.hover(() => $btn.css("color", "#fff"), () => $btn.css("color", "#aaa"));
            $btn.on("click", (e) => { e.preventDefault(); fn(); });
            return $btn;
        };

        $toolbar.append(createAction("Clear", () => this.clear()));
        $toolbar.append(createAction("Copy All", () => this.copyAll()));

        this.$dialog.append($toolbar).append(this.$console);
        $("body").append(this.$dialog);

        this.$dialog.dialog({
            autoOpen: false,
            width: 600,
            height: 400,
            minWidth: 300,
            minHeight: 200,
            modal: false,
            classes: { "ui-dialog": "ai-console-ui" }
        });

        // Smart Autoscroll
        const observer = new MutationObserver(() => {
            this.$console.scrollTop(this.$console[0].scrollHeight);
        });
        observer.observe(this.$console[0], { childList: true });

        // Add custom styles for the dialog header
        if (!$("#ai-console-styles").length) {
            $(`<style id="ai-console-styles">
                .ai-console-ui { border: 1px solid #333 !important; box-shadow: 0 10px 30px rgba(0,0,0,0.5) !important; padding: 0 !important; }
                .ai-console-ui .ui-dialog-titlebar { background: #2d2d2d !important; border: none !important; border-bottom: 2px solid ${this.brandColor} !important; color: #eee !important; border-radius: 0 !important; padding: 0.5em 1em !important; }
                .ai-console-ui .ui-dialog-title { font-size: 13px; font-weight: 500; }
                .ai-console-body::-webkit-scrollbar { width: 8px; }
                .ai-console-body::-webkit-scrollbar-track { background: #1e1e1e; }
                .ai-console-body::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
                .ai-console-body::-webkit-scrollbar-thumb:hover { background: #444; }
                .log-info { color: #d4d4d4; }
                .log-warn { color: #ce9178; font-weight: bold; }
                .log-error { color: #f48771; font-weight: bold; border-left: 3px solid #f48771; padding-left: 5px; }
                .log-ai-header { color: ${this.brandColor}; font-weight: bold; margin-top: 8px; border-top: 1px solid #333; padding-top: 5px; }
                .log-prompt { color: #808080; font-style: italic; }
                .log-response { color: #9cdcfe; }
                .log-glossary { color: #4ec9b0; border-bottom: 1px dashed #4ec9b0; }
            </style>`).appendTo("head");
        }
    }

    toggle() {
        if (!this.$dialog) this.init();
        if (this.$dialog.dialog("isOpen")) {
            this.$dialog.dialog("close");
        } else {
            this.$dialog.dialog("open");
        }
    }

    _append(html) {
        if (!this.$console) this.init();
        const time = new Date().toLocaleTimeString([], { hour12: false });
        this.$console.append(`<div style="margin-bottom:2px;"><span style="color:#666; font-size:10px;">[${time}]</span> ${html}</div>`);
    }

    info(msg) { this._append(`<span class="log-info">${msg}</span>`); }
    warn(msg) { this._append(`<span class="log-warn">⚠️ ${msg}</span>`); }
    error(msg) { this._append(`<span class="log-error">❌ ERROR: ${msg}</span>`); }
    
    glossary(found) {
        if (!found || !found.length) return;
        const list = found.map(f => `<span class="log-glossary" title="${f.category}">${f.original}</span>`).join(", ");
        this._append(`<span style="color:#4ec9b0;">🔍 Glossary Terms:</span> ${list}`);
    }

    ai(prompt, response) {
        this._append(`<div class="log-ai-header">🤖 AI INTERACTION</div>`);
        this._append(`<div class="log-prompt">PROMPT: ${prompt.substring(0, 500)}${prompt.length > 500 ? '...' : ''}</div>`);
        this._append(`<div class="log-response">RESPONSE: ${response}</div>`);
    }

    clear() { this.$console.empty(); }
    copyAll() {
        const text = this.$console.text();
        const el = document.createElement('textarea');
        el.value = text;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        ui.notify("Console logs copied to clipboard!");
    }
}

// Instantiate console
thisEngine.aiConsole = new AiConsole(thisEngine);

// --- QUICK ACCESS BUTTONS INTEGRATION (Premium SVGs) ---
thisEngine.registerQuickAccessButtons = function() {
    const inject = () => {
        let toolbar = $(".toolbar.mainToolbar");
        if (!toolbar.length || $("#ai-compat-toolbar").length) return;

        const brandColor = "#C03962";
        // SVGs Assets with custom color
        const icons = {
            scan: `<svg viewBox="0 0 24 24" fill="none" stroke="${brandColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path><path d="M11 8a3 3 0 0 1 3 3"></path></svg>`,
            clean: `<svg viewBox="0 0 24 24" fill="none" stroke="${brandColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path><path d="M5 3v4"></path><path d="M19 17v4"></path><path d="M3 5h4"></path><path d="M17 19h4"></path></svg>`,
            translate: `<svg viewBox="0 0 24 24" fill="none" stroke="${brandColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>`,
            console: `<svg viewBox="0 0 24 24" fill="none" stroke="${brandColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
            settings: `<svg viewBox="0 0 24 24" fill="none" stroke="${brandColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>`
        };

        const $container = $('<div id="ai-compat-toolbar" class="toolbar-content"></div>');
        $container.css({
            "display": "inline-flex",
            "align-items": "center",
            "gap": "4px",
            "margin-left": "8px",
            "padding-left": "8px",
            "border-left": "1px solid rgba(255,255,255,0.1)"
        });

        const createBtn = (id, svg, title, actionName) => {
            const $btn = $(`<button id="${id}" class="toolbutton ai-btn" title="${title}" style="padding:4px;display:flex;align-items:center;justify-content:center;transition:all 0.2s;opacity:0.85;">${svg}</button>`);
            $btn.on("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (actionName === "openOptions") {
                    ui.openOptionsWindow({
                        focus: {
                            menu: thisAddon.package.name
                        }
                    });
                } else if (actionName === "toggleConsole") {
                    thisEngine.aiConsole.toggle();
                } else if (actionName === "cleanGlossaryWithAI") {
                    const raw = thisEngine.getOptions("glossaryText");
                    thisEngine.cleanGlossaryWithAI(raw).then(cleaned => {
                        if (cleaned) {
                            thisEngine.update("glossaryText", cleaned);
                            thisEngine.syncFormValue("glossaryText", cleaned);
                        }
                    });
                } else if (typeof thisEngine[actionName] === "function") {
                    thisEngine[actionName]();
                }
            });
            $btn.hover(
                function() { $(this).css({"opacity": "1", "background": "rgba(192, 57, 98, 0.15)", "transform": "translateY(-1px)"}); },
                function() { $(this).css({"opacity": "0.85", "background": "transparent", "transform": "translateY(0)"}); }
            );
            return $btn;
        };

        $container.append(createBtn("ai-scan-btn", icons.scan, "Scan Project Glossary", "scanProjectGlossary"));
        $container.append(createBtn("ai-clean-btn", icons.clean, "Clean Glossary with AI", "cleanGlossaryWithAI"));
        $container.append(createBtn("ai-trans-btn", icons.translate, "Translate Glossary with AI", "translateGlossaryWithAI"));
        $container.append(createBtn("ai-console-btn", icons.console, "AI Integration Console", "toggleConsole"));
        $container.append(createBtn("ai-settings-btn", icons.settings, "AI Engine Settings", "openOptions"));

        toolbar.append($container);
    };

    inject();
    trans.on("projectLoaded", inject);
};

$(document).ready(() => {
    setTimeout(() => thisEngine.registerQuickAccessButtons(), 2000);
});

thisEngine.invalidateClient = function() {
    this.client = null;
    this.lastClientFingerprint = "";
};

thisEngine.invalidateProjectCache = function() {
    this.projectIndex = null;
    this.projectFingerprint = "";
};

thisEngine.syncFormValue = function(fieldName, value, anchor) {
    const self = this;
    setTimeout(() => {
        try {
            // Robust scoped search
            const $scope = anchor ? $(anchor).closest(".ui-dialog, form, .options-form, body") : $("body");
            const selector = `[name$="[${fieldName}]"], [name="${fieldName}"], #${fieldName}, [id*="${fieldName}"]`;
            let $fields = $scope.find(selector);
            
            if (!$fields.length && anchor) $fields = $(selector);
            if (!$fields.length) {
                $fields = $scope.find("input, select, textarea").filter(function() {
                    const name = $(this).attr("name") || "";
                    const id = $(this).attr("id") || "";
                    return name.toLowerCase().includes(fieldName.toLowerCase()) || 
                           id.toLowerCase().includes(fieldName.toLowerCase());
                });
            }

            $fields.each(function() {
                $(this).val(value).trigger("change").triggerHandler("change");
            });
        } catch (error) {
            console.warn("[transOpenAICompat] Sync error", fieldName, error);
        }
    }, 150); 
};

thisEngine.setModelChoices = function(modelIds) {
    const uniqueModels = uniqueStrings(modelIds);
    this.optionsForm.schema.model.enum = uniqueModels;
    this.update("availableModelsText", uniqueModels.join("\n"));
    this.syncFormValue("availableModelsText", uniqueModels.join("\n"));
    try {
        const $modelInputs = $(`select[name="model"], select[name$="[model]"], select[id*="model"], [name="model"], [name$="[model]"]`);
        $modelInputs.each(function() {
            const $input = $(this);
            if ($input.is("select")) {
                const currentValue = $input.val();
                $input.empty();
                for (const modelId of uniqueModels) {
                    $input.append($("<option>").attr("value", modelId).text(modelId));
                }
                if (currentValue && uniqueModels.includes(currentValue)) {
                    $input.val(currentValue);
                } else if (uniqueModels.length) {
                    $input.val(uniqueModels[0]);
                }
                return;
            }
            const listId = $input.attr("list");
            if (!listId) return;
            const $datalist = $(`#${listId}`);
            if (!$datalist.length) return;
            $datalist.empty();
            for (const modelId of uniqueModels) {
                $datalist.append($("<option>").attr("value", modelId));
            }
        });
    } catch (error) {
        console.warn("Unable to refresh model datalist", error);
    }
    if (uniqueModels.length && !uniqueModels.includes(this.getOptions("model"))) {
        this.update("model", uniqueModels[0]);
    }
    this.syncFormValue("model", this.getOptions("model"));
};

thisEngine.applyProviderPreset = function(providerId, anchor) {
    const preset = getProviderPreset(providerId);
    this.update("provider", providerId);
    this.update("baseUrl", preset.baseURL);
    this.update("model", preset.model);
    if (!preset.needsApiKey) {
        this.update("apiKey", preset.apiKey || "");
    }
    this.syncFormValue("provider", providerId, anchor);
    this.syncFormValue("baseUrl", preset.baseURL, anchor);
    this.syncFormValue("model", preset.model, anchor);
    if (!preset.needsApiKey) this.syncFormValue("apiKey", preset.apiKey || "", anchor);
    this.invalidateClient();
};

thisEngine.resolveBaseUrl = function() {
    const configured = String(this.getOptions("baseUrl") || "").trim();
    if (configured) return configured;
    return getProviderPreset(this.getOptions("provider")).baseURL;
};

thisEngine.resolveApiKey = function() {
    const configured = String(this.getOptions("apiKey") || "").trim();
    if (configured) return configured;
    const preset = getProviderPreset(this.getOptions("provider"));
    return preset.apiKey || "dummy-key";
};

thisEngine.getClient = function() {
    const fingerprint = JSON.stringify({
        baseURL: this.resolveBaseUrl(),
        apiKey: this.resolveApiKey()
    });
    if (this.client && this.lastClientFingerprint === fingerprint) return this.client;

    this.client = new OpenAI({
        apiKey: this.resolveApiKey(),
        baseURL: this.resolveBaseUrl(),
        dangerouslyAllowBrowser: true
    });
    this.lastClientFingerprint = fingerprint;
    return this.client;
};

thisEngine.getRequestHeaders = function() {
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.resolveApiKey()}`
    };
};

thisEngine.getModelsEndpoint = function() {
    const baseUrl = this.resolveBaseUrl().replace(/\/+$/, "");
    return `${baseUrl}/models`;
};

thisEngine.fetchAvailableModels = async function() {
    const response = await fetch(this.getModelsEndpoint(), {
        method: "GET",
        headers: this.getRequestHeaders()
    });
    if (!response.ok) {
        throw new Error(`Model discovery failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    const candidateItems = []
        .concat(ensureArray(payload?.data))
        .concat(ensureArray(payload?.models))
        .concat(Array.isArray(payload) ? payload : [])
        .concat(ensureArray(payload?.result?.data))
        .concat(ensureArray(payload?.result?.models));
    let ids = uniqueStrings(candidateItems.map((item) => {
        if (typeof item === "string") return item;
        return item?.id || item?.name || item?.model;
    }));
    if (!ids.length) {
        try {
            const client = this.getClient();
            const fallback = await client.models.list();
            ids = uniqueStrings(ensureArray(fallback?.data).map((item) => item?.id || item?.name));
        } catch (fallbackError) {
            console.warn("Fallback model listing failed", fallbackError);
        }
    }
    this.update("availableModelsText", ids.length ? ids.join("\n") : safeJsonStringify(payload, ""));
    this.syncFormValue("availableModelsText", ids.length ? ids.join("\n") : safeJsonStringify(payload, ""));
    this.setModelChoices(ids);
    return ids;
};

thisEngine.showAvailableModels = async function() {
    try {
        const modelIds = await this.fetchAvailableModels();
        console.log("Available models:", modelIds);
        if (modelIds.length && !modelIds.includes(this.getOptions("model"))) {
            this.update("model", modelIds[0]);
            this.syncFormValue("model", modelIds[0]);
            await ui.log(`Model updated to ${modelIds[0]}`);
        }
        if (!modelIds.length) {
            this.update("availableModelsText", "No models returned by the endpoint.");
            this.syncFormValue("availableModelsText", "No models returned by the endpoint.");
        }
        return modelIds;
    } catch (error) {
        console.error(error);
        this.update("availableModelsText", `Unable to list models: ${error.message}`);
        this.syncFormValue("availableModelsText", `Unable to list models: ${error.message}`);
        throw error;
    }
};

thisEngine.applyPerformancePreset = function(presetName) {
    const presets = {
        speed: {
            contextMode: "light",
            useSlidingWindow: false,
            maxConcurrentRequest: 3,
            rowLimitPerBatch: 10,
            temperature: 0.1,
            reasoningEffort: "",
            thinkingMode: "disabled",
            maxContextHints: 1
        },
        balanced: {
            contextMode: "balanced",
            useSlidingWindow: true,
            maxConcurrentRequest: 1,
            rowLimitPerBatch: 6,
            temperature: 0.2,
            reasoningEffort: "",
            thinkingMode: "auto",
            maxContextHints: 2
        },
        quality: {
            contextMode: "balanced",
            useSlidingWindow: true,
            maxConcurrentRequest: 0,
            rowLimitPerBatch: 4,
            temperature: 0.15,
            reasoningEffort: "low",
            thinkingMode: "auto",
            maxContextHints: 3
        },
        reasoning: {
            contextMode: "balanced",
            useSlidingWindow: true,
            maxConcurrentRequest: 0,
            rowLimitPerBatch: 4,
            temperature: 0.1,
            reasoningEffort: "medium",
            thinkingMode: "enabled",
            maxContextHints: 3
        }
    };

    const preset = presets[presetName];
    if (!preset) return;
    for (const [key, value] of Object.entries(preset)) {
        this.update(key, value);
        this.syncFormValue(key, value);
    }
    this.update("activePreset", presetName);
    this.syncFormValue("activePreset", presetName);
    ui.log(`Applied preset: ${presetName}`);
};

thisEngine.scanProjectGlossary = async function() {
    this.aiConsole.toggle();
    this.aiConsole.info("🚀 Starting full project glossary scan (Advanced Engine)...");
    ui.log("Scanning project for glossary candidates...");
    const projectIndex = this.buildProjectIndex();
    const sections = [];
    const globalSeen = new Set();

    // Helper to build sections avoiding global duplicates
    const buildUniqueSection = (title, bucket, duplicateValue) => {
        const rawValues = projectIndex.knowledge[bucket] || [];
        const uniqueValues = [];
        for (const val of rawValues) {
            const normalized = val.trim();
            if (!normalized || globalSeen.has(normalized.toLowerCase())) continue;
            if (!isGoodGlossaryCandidate(normalized)) continue;
            
            globalSeen.add(normalized.toLowerCase());
            uniqueValues.push(normalized);
        }
        
        if (!uniqueValues.length) return "";
        const lines = [`# ${title}`];
        for (const value of uniqueValues) {
            lines.push(`${value} => ${duplicateValue ? value : ""}`.trimEnd());
        }
        return lines.join("\n");
    };

    sections.push(buildUniqueSection("SPEAKERS", "speakers", true));
    sections.push(buildUniqueSection("ACTORS", "actors", true));
    sections.push(buildUniqueSection("LOCATIONS", "locations", true));
    sections.push(buildUniqueSection("ITEMS_SKILLS_STATES", "terms", false));
    sections.push(buildUniqueSection("SYSTEM_TERMS", "systemTerms", false));

    let glossaryText = sections.filter(Boolean).join("\n\n").trim();
    
    // Auto-clean if possible
    if (glossaryText && this.getOptions("autoCleanGlossary")) {
        ui.log("Auto-cleaning glossary with AI...");
        glossaryText = await this.cleanGlossaryWithAI(glossaryText);
    }

    this.update("glossaryText", glossaryText);
    this.syncFormValue("glossaryText", glossaryText);
    this.refreshContextPreview();
    const lineCount = glossaryText ? glossaryText.split(/\r?\n/).length : 0;
    this.aiConsole.info(`✅ Scan complete. Found <span style="color:#4ec9b0">${lineCount}</span> unique terms.`);
    await ui.log(`Scanned project glossary with ${lineCount} unique terms.`);
    alert(`Glossary scan complete!\nFound ${lineCount} unique terms after deduplication.`);
    return glossaryText;
};


thisEngine.cleanGlossaryWithAI = async function(rawGlossary) {
    if (!rawGlossary) return "";
    this.aiConsole.toggle();
    this.aiConsole.info("🧹 Starting advanced AI glossary cleaning...");
    ui.log("Starting advanced AI glossary cleaning...");

    const lines = rawGlossary.split(/\r?\n/);
    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;
    let currentSection = "";
    const MAX_CHUNK_LENGTH = 3500;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("# ")) {
            currentSection = trimmed;
            currentChunk.push(trimmed);
            continue;
        }
        
        currentChunk.push(trimmed);
        currentLength += trimmed.length;

        if (currentLength > MAX_CHUNK_LENGTH) {
            chunks.push(currentChunk.join("\n"));
            // Start next chunk with the last known section for context
            currentChunk = currentSection ? [currentSection] : [];
            currentLength = 0;
        }
    }
    if (currentChunk.length > 1) chunks.push(currentChunk.join("\n"));

    const cleanedChunks = [];
    const promptBase = `You are a professional localization editor. CLEAN this game glossary.
RULES:
1. NEVER delete character names or Speakers unless they are technical IDs (like EV001).
2. REMOVE technical IDs (Map###, EV###, e###, h###).
3. REMOVE battle event labels (e.g., terms ending in 'との戦闘', 'の出現', 'の勝利').
4. REMOVE system/debug messages (e.g., 'Increase level', 'Get gold', 'Set HP').
5. KEEP the '# SECTION' headers.
6. Output format: 'Source => Source' or '# SECTION'.

Glossary part:
`;

    try {
        for (let i = 0; i < chunks.length; i++) {
            ui.log(`Cleaning part ${i + 1}/${chunks.length}...`);
            this.aiConsole.info(`📡 Sending chunk ${i + 1}/${chunks.length} to AI...`);
            const response = await this.callChatCompletion([
                { role: "system", content: promptBase },
                { role: "user", content: chunks[i] }
            ], { response_format: { type: "text" } });
            
            if (response) {
                cleanedChunks.push(response.trim());
                this.aiConsole.ai(promptBase + "\n" + chunks[i], response);
            }
        }

        const finalLines = cleanedChunks.join("\n").split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => {
                if (!l) return false;
                if (l.startsWith("# ")) return true;
                if (!l.includes("=>")) return false;
                
                const term = l.split("=>")[0].trim();
                // Anti-battle-label filter (Japanese)
                if (/(との戦闘|の出現|の勝利|との遭遇|の敗北)$/.test(term)) return false;
                // Anti-debug filter
                if (/^(Increase|Decrease|Get|Set|Full|Start|Show)\s/i.test(term)) return false;
                
                return isGoodGlossaryCandidate(term);
            });

        // Re-construct with grouping
        let result = "";
        let lastSection = "";
        for (const line of finalLines) {
            if (line.startsWith("# ")) {
                if (line !== lastSection) {
                    result += "\n" + line + "\n";
                    lastSection = line;
                }
            } else {
                result += line + "\n";
            }
        }
        
        ui.log("Advanced AI cleanup complete.");
        return result.trim();
    } catch (error) {
        ui.error(`AI Cleaning failed: ${error.message}`);
        return rawGlossary;
    }
};



/**
 * Fase 2: Traduce el glosario filtrado y ASIGNA CATEGORÍAS (Personaje, Objeto, etc.)
 * Basado en la arquitectura de TraduCSVNONUBE para máxima precisión semántica.
 * Utiliza JSON estructurado para evitar comentarios y basura de la IA.
 */
thisEngine.translateGlossaryWithAI = async function() {
    const rawText = this.getOptions("glossaryText");
    if (!rawText || !rawText.trim()) {
        alert("Glossary is empty. Scan first!");
        return;
    }

    ui.log("AI is translating and categorizing glossary terms (JSON mode)...");
    this.aiConsole.toggle();
    this.aiConsole.info("🌐 Starting AI glossary translation and categorization...");
    const sl = langTools.getName(trans.getSl());
    const tl = langTools.getName(trans.getTl());

    // Chunking: 30 terms per batch for reliability
    const lines = rawText.split(/\r?\n/).filter(l => l.trim() && !l.startsWith("#"));
    const chunks = [];
    let currentChunk = [];
    for (const line of lines) {
        currentChunk.push(line.includes("=>") ? line.split("=>")[0].trim() : line.trim());
        if (currentChunk.length >= 30) {
            chunks.push(currentChunk);
            currentChunk = [];
        }
    }
    if (currentChunk.length) chunks.push(currentChunk);

    const systemPrompt = `You are a professional game localizer.
Translate the list of game terms from ${sl} to ${tl} and categorize them.

STRICT RULES:
- Return ONLY a JSON object with a "terms" array.
- Each item must have: "original", "translation", "category".
- "category" must be one of: Character (Male/Female), Object, Skill, Location, UI, or General.
- DO NOT add English explanations or parentheses.
- DO NOT add notes, commentary, or introduction.
- Return ONLY the JSON.

Example:
{
  "terms": [
    {"original": "Staff", "translation": "Bastón", "category": "Object"}
  ]
}`;

    const finalEntries = [];
    try {
        for (let i = 0; i < chunks.length; i++) {
            ui.log(`Processing batch ${i + 1}/${chunks.length}...`);
            const response = await this.callChatCompletion([
                { role: "system", content: systemPrompt },
                { role: "user", content: `Terms to process:\n${chunks[i].join("\n")}` }
            ], { response_format: { type: "json_object" } });
            
            if (response) {
                this.aiConsole.ai(systemPrompt + "\n" + chunks[i].join("\n"), response);
                const data = parseLooseJsonObject(response, {});
                const terms = ensureArray(data.terms || data.items || []);
                for (const t of terms) {
                    if (t.original && t.translation) {
                        const cleanTrans = t.translation.split(/[\\/()]/)[0].trim(); // Anti-hallucination/multi-choice
                        finalEntries.push(`${t.original} => ${cleanTrans} || ${t.category || "General"}`);
                    }
                }
            }
        }

        const finalGlossary = "# CATEGORIZED GLOSSARY\n" + finalEntries.join("\n");
        this.update("glossaryText", finalGlossary);
        this.syncFormValue("glossaryText", finalGlossary);
        ui.log("Glossary translation and categorization complete.");
        alert("Glossary has been translated and categorized without noise!");
    } catch (error) {
        ui.error(`Glossary translation failed: ${error.message}`);
        alert(`Error: ${error.message}`);
    }
};




thisEngine.refreshContextPreview = function() {
    try {
        const projectIndex = this.buildProjectIndex();
        const sampleRows = [];
        const project = trans.project || {};
        const files = project.files || {};
        const keyColumn = typeof trans.keyColumn === "number" ? trans.keyColumn : 0;
        for (const filePath of Object.keys(files)) {
            const rows = ensureArray(files[filePath]?.data);
            for (const row of rows) {
                const source = typeof row?.[keyColumn] === "string" ? row[keyColumn] : "";
                if (!source || !source.trim()) continue;
                sampleRows.push(source);
                if (sampleRows.length >= 3) break;
            }
            if (sampleRows.length >= 3) break;
        }

        const preview = [
            "Project knowledge:",
            this.buildProjectKnowledgeBlock(projectIndex),
            "",
            "Sample row hints:",
            this.buildRowContextBlock(sampleRows, projectIndex)
        ].join("\n");

        this.update("contextPreviewText", preview);
        this.syncFormValue("contextPreviewText", preview);
        return preview;
    } catch (error) {
        const message = `Unable to build context preview: ${error.message}`;
        this.update("contextPreviewText", message);
        this.syncFormValue("contextPreviewText", message);
        return message;
    }
};

thisEngine.exportGlossary = async function() {
    const defaultName = `${(trans.project?.gameTitle || "translatorpp-glossary").replace(/[\\/:*?"<>|]+/g, "_")}.txt`;
    const targetPath = await ui.openFileDialog({
        save: defaultName
    });
    if (!targetPath) return "";
    await common.filePutContents(targetPath, this.getOptions("glossaryText") || "");
    await ui.log(`Glossary exported to ${targetPath}`);
    return targetPath;
};

thisEngine.importGlossary = async function() {
    const sourcePath = await ui.openFileDialog({
        accept: ".txt,.md,.csv,.tsv,.json"
    });
    if (!sourcePath) return "";
    const fileContent = await common.fileGetContents(sourcePath);
    this.update("glossaryText", String(fileContent || ""));
    this.syncFormValue("glossaryText", String(fileContent || ""));
    await ui.log(`Glossary imported from ${sourcePath}`);
    return sourcePath;
};

thisEngine.testConnection = async function() {
    const modelBefore = this.getOptions("model");
    const models = await this.fetchAvailableModels();
    let chosenModel = modelBefore;
    if (!chosenModel || !models.includes(chosenModel)) {
        chosenModel = models[0] || chosenModel;
        if (chosenModel) this.update("model", chosenModel);
    }

    const prompt = this.getOptions("connectionTestPrompt") || "Reply only with: OK";
    const startedAt = Date.now();
    const responseText = await this.callChatCompletion([
        { role: "system", content: "Reply tersely." },
        { role: "user", content: prompt }
    ], {});
    const elapsed = Date.now() - startedAt;
    const summary = [
        `Provider: ${this.getOptions("provider")}`,
        `Model: ${chosenModel || "(none)"}`,
        `Models discovered: ${models.length}`,
        `Latency: ${elapsed} ms`,
        `Response: ${shortenText(responseText, 160)}`
    ].join("\n");
    console.log(summary);
    this.update("availableModelsText", `${models.join("\n")}\n\n---\n${summary}`.trim());
    this.syncFormValue("availableModelsText", `${models.join("\n")}\n\n---\n${summary}`.trim());
    return { models, responseText, elapsed };
};

thisEngine.getProjectFingerprint = function() {
    const project = trans.project || {};
    const files = project.files || {};
    const fileKeys = Object.keys(files);
    let rowCount = 0;
    for (const fileKey of fileKeys) {
        rowCount += ensureArray(files[fileKey]?.data).length;
    }
    return JSON.stringify({
        title: project.gameTitle || project.title || "",
        engine: project.gameEngine || "",
        fileCount: fileKeys.length,
        rowCount
    });
};

thisEngine.buildProjectIndex = function() {
    if (!this.getOptions("autoBuildProjectKnowledge")) {
        return {
            bySource: {},
            knowledge: {
                speakers: [],
                actors: [],
                locations: [],
                terms: [],
                systemTerms: []
            }
        };
    }

    const currentFingerprint = this.getProjectFingerprint();
    if (this.projectIndex && this.projectFingerprint === currentFingerprint) {
        return this.projectIndex;
    }

    const project = trans.project || {};
    const files = project.files || {};
    const index = {
        bySource: {},
        knowledge: {
            speakers: [],
            actors: [],
            locations: [],
            terms: [],
            systemTerms: []
        }
    };

    const addKnowledge = (bucket, text) => {
        const normalized = String(text || "").trim();
        if (!normalized || normalized.length < 2 || normalized.length > 80) return;
        if (normalized.includes("\n")) return;
        if (looksLikePlaceholderOnly(normalized)) return;
        
        index.knowledge[bucket] ||= [];
        if (!index.knowledge[bucket].includes(normalized)) {
            index.knowledge[bucket].push(normalized);
        }
    };

    const DB_ONLY_KEYS = ["name", "message", "message1", "message2", "description"];
    const GLOBAL_KEYS = ["speaker", "nickname", "nick_name", "display_name", "displayName"];
    const BLACKLISTED_KEYS = ["script", "comment", "code", "indent", "parameters", "list", "pages", "events", "note", "id", "x", "y"];
    const DATABASE_FILES = ["actors", "armors", "classes", "enemies", "items", "mapinfos", "skills", "states", "troops", "weapons"];
    
    const keyColumn = typeof trans.keyColumn === "number" ? trans.keyColumn : 0;

    for (const filePath of Object.keys(files)) {
        const fileObj = files[filePath] || {};
        const rows = ensureArray(fileObj.data);
        const rowParameters = fileObj.parameters || [];
        const rowContexts = fileObj.context || [];
        const normalizedPath = filePath.replace(/\\/g, "/");
        const baseName = basenameFromPath(normalizedPath).toLowerCase();
        
        // SKIP script files entirely
        if (/scripts?\//i.test(normalizedPath) || baseName.includes("script") || baseName.endsWith(".rb") || baseName.endsWith(".js")) {
            continue;
        }

        const isDatabaseFile = DATABASE_FILES.some(dbf => baseName.includes(dbf));

        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            const row = rows[rowIndex];
            if (!row) continue;

            const source = typeof row?.[keyColumn] === "string" ? row[keyColumn] : "";
            const contexts = ensureArray(rowContexts[rowIndex] || []);
            const params = rowParameters[rowIndex] || [];

            // A. PRIORITY SPEAKER DETECTION (Context-based)
            if (contexts.some(c => String(c).toLowerCase().includes("speaker"))) {
                if (source && source.trim().length > 1 && source.length < 50) {
                    addKnowledge("speakers", source);
                }
            }

            // B. PRIORITY SPEAKER DETECTION (Parameter-based)
            const infoFromParams = collectRowInfoTexts(params);
            for (const text of infoFromParams) {
                if (isGoodGlossaryCandidate(text)) {
                    addKnowledge("speakers", text);
                }
            }

            // C. SKIP Technical rows (comments, scripts)
            const isTechnical = contexts.some(c => {
                const low = String(c).toLowerCase();
                return low.includes("comment") || low.includes("script") || low.includes("eval") || low.includes("plugin") || low.includes("note") || low.includes("code") || low.includes("ruby");
            });
            if (isTechnical) continue;

            // D. ATTRIBUTE SCAN (For DB files or global keys)
            let foundSpecificKey = false;
            if (typeof row === "object" && !Array.isArray(row)) {
                for (const key of Object.keys(row)) {
                    const kLower = key.toLowerCase();
                    if (BLACKLISTED_KEYS.some(bk => kLower.includes(bk))) continue;
                    
                    const isGlobal = GLOBAL_KEYS.some(gk => kLower.includes(gk.toLowerCase()));
                    const isDbOnly = DB_ONLY_KEYS.some(dk => kLower.includes(dk.toLowerCase()));
                    
                    if (!isGlobal && (!isDatabaseFile || !isDbOnly)) continue;
                    
                    const value = row[key];
                    if (typeof value !== "string" || !value.trim()) continue;

                    foundSpecificKey = true;
                    index.bySource[value] ||= [];
                    index.bySource[value].push({ path: filePath, rowIndex, key, kind: classifyOccurrenceByFile(baseName, key) });

                    if (kLower.includes("speaker")) addKnowledge("speakers", value);
                    else if (baseName.includes("actor") || kLower.includes("nickname")) addKnowledge("actors", value);
                    else if (baseName.includes("map") || kLower.includes("display")) addKnowledge("locations", value);
                    else if (isDatabaseFile) addKnowledge("terms", value);
                    else addKnowledge("systemTerms", value);
                }
            }

            // E. FALLBACK SCAN
            if (source && source.trim() && !foundSpecificKey) {
                index.bySource[source] ||= [];
                if (!index.bySource[source].some(occ => occ.path === filePath && occ.rowIndex === rowIndex)) {
                    index.bySource[source].push({ path: filePath, rowIndex, key: "source", kind: classifyOccurrenceByFile(baseName, "source") });
                }

                if (isGoodGlossaryCandidate(source)) {
                    if (baseName.includes("actor")) addKnowledge("actors", source);
                    else if (baseName.includes("map")) addKnowledge("locations", source);
                    else if (isDatabaseFile) addKnowledge("terms", source);
                }
            }
        }
    }






    this.projectIndex = index;
    this.projectFingerprint = currentFingerprint;
    return index;
};

function classifyOccurrenceByFile(fileName, key) {
    const k = key.toLowerCase();
    const f = fileName.toLowerCase();
    if (k.includes("speaker")) return "speaker";
    if (f.includes("actor") || k.includes("nickname")) return "actor";
    if (f.includes("map") || k.includes("display")) return "location";
    if (["skill", "item", "weapon", "armor", "state"].some(x => f.includes(x))) return "term";
    if (["class", "enemy", "troop", "system"].some(x => f.includes(x))) return "system_term";
    return "text";
}


thisEngine.buildProjectKnowledgeBlock = function(projectIndex) {
    if (!this.getOptions("autoBuildProjectKnowledge")) return "(disabled)";
    const budget = parseInt(this.getOptions("projectKnowledgeBudget") || "0");
    if (budget < 1) return "(disabled)";

    const lines = [];
    
    // 1. Process explicit glossary with categorization
    const glossaryText = this.getOptions("glossaryText") || "";
    if (glossaryText.trim()) {
        const gLines = glossaryText.split(/\r?\n/).filter(l => l.includes("=>"));
        if (gLines.length) {
            lines.push("### PROJECT GLOSSARY (Strictly follow these):");
            for (const gl of gLines.slice(0, 50)) { // Limit to top 50 for budget
                const parts = gl.split("=>");
                const source = parts[0].trim();
                const rest = parts[1].split("||");
                const target = rest[0].trim();
                const category = rest[1] ? ` (${rest[1].trim()})` : "";
                lines.push(`- ${source}${category} => ${target}`);
            }
            lines.push("");
        }
    }

    const pushBucket = (label, values, maxItems) => {
        const chosen = uniqueStrings(values).slice(0, maxItems);
        if (!chosen.length) return;
        lines.push(`- ${label}: ${chosen.join(", ")}`);
    };

    pushBucket("Characters", projectIndex.knowledge.speakers, 16);
    pushBucket("Actors", projectIndex.knowledge.actors, 16);
    pushBucket("Locations", projectIndex.knowledge.locations, 16);
    pushBucket("Key Terms", projectIndex.knowledge.terms, 20);


    let result = lines.join("\n") || "(none)";
    if (result.length > budget) {
        result = result.substring(0, Math.max(0, budget - 3)) + "...";
    }
    return result;
};

thisEngine.buildRowContextBlock = function(sourceRows, projectIndex, textObj) {
    const mode = this.getOptions("contextMode");
    if (mode === "off") return "(disabled)";

    const neighborhoodSize = parseInt(this.getOptions("contextNeighborhoodSize") || "0");
    const neighborhoodLines = [];

    // Smart Neighborhood Context (Dialogues)
    if (neighborhoodSize > 0 && textObj && textObj.file) {
        try {
            const project = trans.project || {};
            const fileData = project.files[textObj.file]?.data || [];
            const keyColumn = typeof trans.keyColumn === "number" ? trans.keyColumn : 0;
            const currentRow = textObj.row || 0;

            const start = Math.max(0, currentRow - neighborhoodSize);
            const end = Math.min(fileData.length, currentRow + sourceRows.length + neighborhoodSize);

            for (let i = start; i < end; i++) {
                const row = fileData[i];
                const text = String(row?.[keyColumn] || "").trim();
                if (!text) continue;
                
                const isCurrent = i >= currentRow && i < currentRow + sourceRows.length;
                const prefix = isCurrent ? ">>" : "  ";
                neighborhoodLines.push(`${prefix} row ${i + 1}: ${text.substring(0, 100)}`);
            }
        } catch (e) {
            console.warn("Failed to build neighborhood context", e);
        }
    }

    const maxHints = parseInt(this.getOptions("maxContextHints") || "0");
    const lines = [];
    
    if (neighborhoodLines.length) {
        lines.push("Dialogue Flow Context (Neighborhood):");
        lines.push(...neighborhoodLines);
        lines.push("---");
    }

    if (maxHints > 0) {
        lines.push("Project Knowledge Hints:");
        for (const source of sourceRows) {
            const occurrences = projectIndex.bySource[source] || [];
            if (!occurrences.length) continue;
            
            const parts = [];
            for (const occ of occurrences.slice(0, maxHints)) {
                parts.push(`[${occ.kind} in ${basenameFromPath(occ.path)}]`);
            }
            lines.push(`- "${source}": ${parts.join(", ")}`);
        }
    }

    return lines.join("\n") || "(none)";
};


thisEngine.buildPromptParts = function(sourceRows, textObj) {
    const metadata = this.getOptions("includeProjectMetadata")
        ? buildProjectMetadataBlock()
        : {
            TITLE: "(disabled)",
            ENGINE: "(disabled)"
        };
    const projectIndex = this.buildProjectIndex();
    
    // 1. DYNAMIC GLOSSARY FILTERING (Inspired by TraduCSVNONUBE)
    const glossaryText = this.getOptions("glossaryText") || "";
    const relevantEntries = [];
    const foundTermsForLog = [];

    if (glossaryText.trim()) {
        const combinedSource = sourceRows.join(" ").toLowerCase();
        const gLines = glossaryText.split(/\r?\n/).filter(l => l.includes("=>"));
        for (const gl of gLines) {
            const parts = gl.split("=>");
            const source = parts[0].trim();
            if (combinedSource.includes(source.toLowerCase())) {
                const rest = parts[1].split("||");
                const target = rest[0].trim();
                const category = rest[1] ? rest[1].trim() : "Term";
                relevantEntries.push(`- ${source} (${category}) => ${target}`);
                foundTermsForLog.push({ original: source, category: category });
            }
        }
    }
    
    if (foundTermsForLog.length > 0) {
        this.aiConsole.glossary(foundTermsForLog);
    }
    const glossaryBlock = relevantEntries.length ? relevantEntries.join("\n") : "(none)";

    const historyBlock = this.getOptions("useSlidingWindow")
        ? buildHistorySnippet(
            this.recentHistory,
            parseInt(this.getOptions("slidingWindowSize") || "0"),
            parseInt(this.getOptions("historyCharBudget") || "0")
        )
        : "(disabled)";
    const rowContextBlock = this.buildRowContextBlock(sourceRows, projectIndex, textObj);
    const projectKnowledgeBlock = this.buildProjectKnowledgeBlock(projectIndex);

    const maxConcurrent = parseInt(this.getOptions("maxConcurrentRequest") || "0");
    const batchStrategyBlock = maxConcurrent > 1
        ? `high-throughput batch; keep reasoning compact; context mode ${this.getOptions("contextMode")}`
        : `quality-oriented batch; reason over row order and nearby hints; context mode ${this.getOptions("contextMode")}`;

    const protectedRows = sourceRows.map((row) => maskPatterns(row));
    const protectedTexts = protectedRows.map((row) => row.text);

    const templateParams = {
        ...libGPT.templateParameters,
        ...metadata,
        GLOSSARY_BLOCK: glossaryBlock,
        PROJECT_KNOWLEDGE_BLOCK: projectKnowledgeBlock,
        ROW_CONTEXT_BLOCK: rowContextBlock,
        EXTRA_CONTEXT_BLOCK: this.getOptions("extraContext") || "(none)",
        HISTORY_BLOCK: historyBlock,
        SOURCE_JSON: safeJsonStringify(protectedTexts, "[]"),
        LANG_FROM_FULL: langTools.getName(trans.getSl()),
        LANG_TO_FULL: langTools.getName(trans.getTl()),
        ENGINE_RULES_BLOCK: buildEngineRulesBlock(metadata.ENGINE),
        BATCH_STRATEGY_BLOCK: batchStrategyBlock
    };

    const systemPrompt = libGPT.compileTemplate(this.getOptions("systemPromptTemplate"), templateParams);
    
    let uTemplate = this.getOptions("userPromptTemplate");
    if (uTemplate.includes("Return JSON object: {\"translations\":[\"...\"]}.")) {
        uTemplate = uTemplate.replace(
            "Return JSON object: {\"translations\":[\"...\"]}.", 
            "Return a JSON object in this exact format: {\"translations\":[\"string1\", \"string2\", ...]}\nCRITICAL: The `translations` array MUST have exactly the same number of elements as the input array.\nCRITICAL: Do NOT combine multiple translations into a single string. Each input string MUST get exactly one separate output string in the array."
        );
        uTemplate = uTemplate.replace("\nThe translations array length must match the source array length exactly.", "");
    }
    
    const userPrompt = libGPT.compileTemplate(uTemplate, templateParams);

    return {
        systemPrompt,
        userPrompt,
        protectedRows,
        metadata,
        projectIndex
    };
};

thisEngine.callChatCompletion = async function(messages, options) {
    const client = this.getClient();
    const provider = this.getOptions("provider");
    const requestBody = {
        model: this.getOptions("model"),
        messages,
        temperature: parseFloat(this.getOptions("temperature") || "0"),
        top_p: parseFloat(this.getOptions("top_p") || "1"),
        max_tokens: parseInt(this.getOptions("maxTokens") || "0")
    };

    const reasoningEffort = this.getOptions("reasoningEffort");
    if (reasoningEffort) {
        requestBody.reasoning_effort = reasoningEffort;
    }

    const extraBody = parseLooseJsonObject(this.getOptions("extraBodyJson"), {});
    if (extraBody && typeof extraBody === "object" && !Array.isArray(extraBody)) {
        Object.assign(requestBody, extraBody);
    }

    if (provider === "kimi") {
        const thinkingMode = this.getOptions("thinkingMode");
        if (thinkingMode === "enabled" || thinkingMode === "disabled") {
            requestBody.extra_body ||= {};
            requestBody.extra_body.thinking = {
                type: thinkingMode === "enabled" ? "enabled" : "disabled"
            };
        }
    }

    let response;
    let retries = 3;
    let delay = 2000;

    while (retries > 0) {
        try {
            try {
                response = await client.chat.completions.create({
                    ...requestBody,
                    response_format: { type: "json_object" }
                });
            } catch (jsonModeError) {
                response = await client.chat.completions.create(requestBody);
                if (typeof options?.onRequestError === "function") {
                    options.onRequestError(jsonModeError);
                }
            }
            break; // Success!
        } catch (error) {
            retries--;
            if (retries === 0) throw error;
            ui.log(`API call failed: ${error.message}. Retrying in ${delay}ms... (${retries} retries left)`);
            await new Promise(r => setTimeout(r, delay));
            delay *= 2; // Exponential backoff
        }
    }

    return normalizeMessageContent(response?.choices?.[0]?.message);
};


thisEngine.fetchTranslation = async function(texts, sl, tl, textObj, options) {
    if (options && options.batchInfo && options.batchInfo.length > 0) {
        textObj = textObj || {};
        textObj.file = options.batchInfo[0].path;
        textObj.row = options.batchInfo[0].row;
    }

    let effectiveTexts = texts;
    let inputIsArray = Array.isArray(texts);
    
    // --- NATIVE BATCH TRANSLATE BYPASS ---
    // Translator++ natively collapses arrays into a single string joined by \n before sending them to the engine.
    // Local LLMs are terrible at maintaining \n counts inside single strings.
    // We bypass this by grabbing the true Escaped Array directly from textObj.
    if (textObj && Array.isArray(textObj.textArray) && textObj.textArray.length > 1 && !inputIsArray) {
        effectiveTexts = textObj.textArray;
        inputIsArray = true;
    }

    const sourceRows = ensureArray(effectiveTexts).map((row) => String(row || ""));
    const promptParts = this.buildPromptParts(sourceRows, textObj);


    const messages = [
        {
            role: "system",
            content: promptParts.systemPrompt
        },
        {
            role: "user",
            content: promptParts.userPrompt
        }
    ];

    let retries = 3;
    let rawText = "";
    let parsedTranslations = [];

    while (retries > 0) {
        try {
            this.aiConsole.info(`📡 Sending batch of ${sourceRows.length} rows to AI... (Attempts left: ${retries})`);
            rawText = await this.callChatCompletion(messages, options);
            
            // Parse with throwOnFail = true to trigger retry if JSON is broken or items are missing
            parsedTranslations = parseJsonTranslations(rawText, sourceRows.length, true);
            this.aiConsole.ai(promptParts.userPrompt, rawText);
            break; // Success
        } catch (err) {
            retries--;
            this.aiConsole.info(`⚠️ Translation validation failed: ${err.message}. Retrying...`);
            if (retries === 0) {
                this.aiConsole.info(`❌ Failed after 3 attempts. Falling back to safe empty strings to prevent corruption.`);
                this.aiConsole.ai(promptParts.userPrompt, rawText);
                parsedTranslations = parseJsonTranslations(rawText, sourceRows.length, false);
                break;
            }
        }
    }

    const finalTranslations = parsedTranslations.map((translatedRow, index) => {
        let normalized = typeof translatedRow === "string"
            ? translatedRow
            : String(translatedRow ?? "");
        normalized = unmaskPatterns(normalized, promptParts.protectedRows[index].mapping);
        normalized = copyLeadingWhitespace(sourceRows[index], normalized);
        return normalized;
    });

    if (this.debugLevel) {
        console.log("OpenAI-compatible prompt metadata", {
            sl,
            tl,
            model: this.getOptions("model"),
            provider: this.getOptions("provider"),
            title: promptParts.metadata.TITLE,
            engine: promptParts.metadata.ENGINE
        });
        console.log("OpenAI-compatible raw response", rawText);
        console.log("OpenAI-compatible parsed translations", finalTranslations);
    }

    return inputIsArray ? finalTranslations : (finalTranslations[0] || "");
};

thisEngine.finalizeTranslation = function(result) {
    if (!this.getOptions("useSlidingWindow")) return result;
    const sourceRows = ensureArray(result?.source);
    const translatedRows = ensureArray(result?.translation);

    for (let i = 0; i < sourceRows.length; i++) {
        const source = String(sourceRows[i] || "");
        const translation = String(translatedRows[i] || "");
        if (!source.trim() && !translation.trim()) continue;
        this.recentHistory.push({ source, translation });
    }

    const hardLimit = Math.max(parseInt(this.getOptions("slidingWindowSize") || "0") * 4, 20);
    if (this.recentHistory.length > hardLimit) {
        this.recentHistory = this.recentHistory.slice(-hardLimit);
    }

    return result;
};

const originalGetOptions = thisEngine.getOptions;
thisEngine.getOptions = function(key) {
    let value = originalGetOptions.call(this, key);
    if (key === "maxConcurrentRequest") {
        value = parseInt(value, 10);
        if (isNaN(value) || value < 1) {
            return 1;
        }
    }
    return value;
};

thisAddon.openTesterWindow = function() {
    const testerPath = `${thisAddon.getPathRelativeToRoot()}/tester/openaiCompatTester.html`;
    nw.Window.open(testerPath, {
        width: 1100,
        height: 820,
        min_width: 900,
        min_height: 700
    });
};

thisAddon.translateSample = async function(inputText) {
    const rows = String(inputText || "").split(/\r?\n/);
    const result = await thisEngine.translate(rows, {
        sl: trans.getSl(),
        tl: trans.getTl()
    });
    return ensureArray(result?.translation).join("\n");
};

$(document).ready(function() {
    trans.getTranslatorEngine(thisEngine.id).init();
    thisEngine.syncFormValue("activePreset", thisEngine.getOptions("activePreset") || "custom");
    const cachedModels = uniqueStrings(String(thisEngine.getOptions("availableModelsText") || "").split(/\r?\n/).filter((line) => line && !line.startsWith("---") && !line.startsWith("Provider:") && !line.startsWith("Model:") && !line.startsWith("Models discovered:") && !line.startsWith("Latency:") && !line.startsWith("Response:")));
    if (cachedModels.length) {
        thisEngine.setModelChoices(cachedModels);
    }
    thisEngine.refreshContextPreview();
});
