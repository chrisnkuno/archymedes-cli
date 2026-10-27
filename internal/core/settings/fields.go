// Code generated once from packages/friday-cli/src/platform/settings.ts by
// tooling/port/settings-fixtures.ts (WS-50.2); edited by hand from here on.

package settings

// Fields are the Settings list, in its order: every setting a person may set. Unknown keys in
// settings.json are dropped on save. A section heading starts at its first field.
var Fields = []Field{
	{Key: "ARCHYMEDES_THEME", Label: "Theme — colours for the whole CLI (/theme <name> also saves it)", Section: "Appearance", Themes: true},
	{Key: "ARCHYMEDES_CODE_COLORS", Label: "Code colours", Choices: codeColorChoices},
	{Key: "ARCHYMEDES_CODE_LINE_NUMBERS", Label: "Line numbers in code blocks", Choices: showHideChoices},
	{Key: "ARCHYMEDES_SIMPLE", Label: "Simple mode — quiet start, short help", Choices: simpleChoices},
	{Key: "ARCHYMEDES_LANGUAGE", Label: "Control language", Choices: languageChoices()},
	{Key: "ARCHYMEDES_REASONING", Label: "Reasoning effort — clear it to leave each model at its own default", Choices: reasoningChoices},
	{Key: "ARCHYMEDES_RESUME", Label: "Continue your last chat at startup", Section: "Behaviour", Choices: resumeChoices},
	{Key: "ARCHYMEDES_ENGINE", Label: "Engine — what runs your sessions (applies to the next session)", Choices: engineChoices},
	{Key: "ARCHYMEDES_EDITOR_AUTOSAVE", Label: "Auto-save in /edit", Choices: autosaveChoices},
	{Key: "ARCHYMEDES_VIM", Label: "Vim keys in the input — esc for normal mode, i to type (/vim switches)", Choices: vimChoices},
	{Key: "ARCHYMEDES_SUGGEST", Label: "Suggestions — next steps, notes on edits, hints while typing", Choices: suggestChoices},
	{Key: "ARCHYMEDES_SUGGEST_MODEL", Label: "Ask the model for extra suggestions (a small extra call per turn)", Choices: onOffChoices},
	{Key: "ARCHYMEDES_NOTIFY", Label: "Notifications — when a turn ends or Friday waits for you", Choices: notifyChoices},
	{Key: "ARCHYMEDES_NOTIFY_URL", Label: "Push URL for notifications, such as https://ntfy.sh/your-topic (event and folder name only)", URL: true},
	{Key: "ARCHYMEDES_AUTO_UPDATE", Label: "Automatic updates — install daily by default", Choices: autoUpdateChoices},
	{Key: "ARCHYMEDES_TELEMETRY", Label: "Install count — one anonymous cue per new version (event, version, OS)", Choices: telemetryChoices},
	{Key: "ARCHYMEDES_TEST_FIRST", Label: "Build test first — tests, then code, then static analysis", Choices: testFirstChoices},
	{Key: "ARCHYMEDES_JEV", Label: "Jev second opinion — verdicts, tool checks, ranked suggestions", Choices: jevChoices},
	{Key: "ARCHYMEDES_KEYS", Label: "Key bindings, e.g. /diff=alt+d,/wander=off"},
	{Key: "ARCHYMEDES_SANDBOX", Label: "Command sandbox (Linux, bubblewrap): commands write only to the project and /tmp", Choices: sandboxChoices},
	{Key: "ARCHYMEDES_SANDBOX_NETWORK", Label: "Network inside the command sandbox", Choices: sandboxNetworkChoices},
	{Key: "FREE_MODEL", Label: "Free mode model (openrouter/free or publisher/model:free)", Section: "Free mode"},
	{Key: "ARCHYMEDES_TOKEN_SAVER", Label: "Free mode token saver", Choices: tokenSaverChoices},
	{Key: "ARCHYMEDES_TOKEN_METER", Label: "Token meter in the status line", Choices: tokenMeterChoices},
	{Key: "ARCHYMEDES_COUNTRY", Label: "Location — sets the currency costs are shown in", Section: "Money", Choices: countryChoices()},
	{Key: "ARCHYMEDES_CURRENCY", Label: "Display currency (overrides the one your location implies)", Choices: currencyChoices()},
	{Key: "ARCHYMEDES_ACCOUNT_BALANCE", Label: "Tracked spend balance — drawn down by each turn's measured cost"},
	{Key: "ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY", Label: "Currency of the tracked balance (defaults to the display currency)"},
	{Key: "ARCHYMEDES_LOW_BALANCE", Label: "Low-balance alert threshold, in the balance currency"},
	{Key: "ARCHYMEDES_CRITICAL_BALANCE", Label: "Critical-balance threshold, in the balance currency"},
	{Key: "ARCHYMEDES_PROVIDER", Label: "Default provider", Section: "Providers", Choices: providerChoices()},
	{Key: "ARCHYMEDES_FALLBACK_MODEL", Label: "Fallback after transient provider failure — ask, or provider:model"},
	{Key: "CLAUDE_MODEL", Label: "Claude model (your subscription) — opus, sonnet, haiku or a model id; empty for the default"},
	{Key: "CODEX_MODEL", Label: "Codex model (your ChatGPT plan) — a model id from Codex's list; empty for Codex's default"},
	{Key: "ANTHROPIC_API_KEY", Label: "Anthropic API key", Secret: true},
	{Key: "ANTHROPIC_BASE_URL", Label: "Anthropic base URL", URL: true},
	{Key: "ANTHROPIC_MODEL", Label: "Anthropic model"},
	{Key: "OPENAI_API_KEY", Label: "OpenAI API key", Secret: true},
	{Key: "OPENAI_BASE_URL", Label: "OpenAI-compatible base URL", URL: true},
	{Key: "OPENAI_MODEL", Label: "OpenAI model"},
	{Key: "ARCHYMEDES_CLOUD_TOKEN", Label: "Archymedes Cloud access token", Secret: true},
	{Key: "ARCHYMEDES_CLOUD_BASE_URL", Label: "Archymedes Cloud base URL", URL: true},
	{Key: "ARCHYMEDES_CLOUD_MODEL", Label: "Archymedes Cloud route (default auto)"},
	{Key: "ARCHYMEDES_CLOUD_MAXIMUM_MICROS", Label: "Maximum cloud credits reserved per model call, in micros"},
	{Key: "ARCHYMEDES_CLOUD_CURRENCY", Label: "Cloud credit currency"},
	{Key: "ARCHYMEDES_CLOUD_REGION", Label: "Cloud routing region"},
	{Key: "ARCHYMEDES_CLOUD_DATA_POLICY", Label: "Cloud data policy"},
	{Key: "ARCHYMEDES_CLOUD_QUALITY_FLOOR", Label: "Cloud routing quality floor (0 to 1)"},
	{Key: "ARCHYMEDES_CLOUD_TASK_KIND", Label: "Cloud task kind (coding, design, architecture, security, research, deployment)"},
	{Key: "GOOGLE_API_KEY", Label: "Google Gemini API key", Secret: true},
	{Key: "GOOGLE_BASE_URL", Label: "Google Gemini base URL", URL: true},
	{Key: "GOOGLE_MODEL", Label: "Google Gemini model"},
	{Key: "XAI_API_KEY", Label: "xAI (Grok) API key", Secret: true},
	{Key: "XAI_BASE_URL", Label: "xAI base URL", URL: true},
	{Key: "XAI_MODEL", Label: "xAI (Grok) model"},
	{Key: "DEEPSEEK_API_KEY", Label: "DeepSeek API key", Secret: true},
	{Key: "DEEPSEEK_BASE_URL", Label: "DeepSeek base URL", URL: true},
	{Key: "DEEPSEEK_MODEL", Label: "DeepSeek model"},
	{Key: "MISTRAL_API_KEY", Label: "Mistral API key", Secret: true},
	{Key: "MISTRAL_BASE_URL", Label: "Mistral base URL", URL: true},
	{Key: "MISTRAL_MODEL", Label: "Mistral model"},
	{Key: "GROQ_API_KEY", Label: "Groq API key", Secret: true},
	{Key: "GROQ_BASE_URL", Label: "Groq base URL", URL: true},
	{Key: "GROQ_MODEL", Label: "Groq model"},
	{Key: "OPENAI_COMPATIBLE_API_KEY", Label: "OpenAI-compatible API key", Secret: true},
	{Key: "OPENAI_COMPATIBLE_BASE_URL", Label: "OpenAI-compatible base URL", URL: true},
	{Key: "OPENAI_COMPATIBLE_MODEL", Label: "OpenAI-compatible model"},
	{Key: "OLLAMA_BASE_URL", Label: "Ollama base URL (default http://localhost:11434/v1)", URL: true},
	{Key: "OLLAMA_MODEL", Label: "Ollama model"},
	{Key: "OPENROUTER_API_KEY", Label: "OpenRouter API key (direct + free mode)", Secret: true},
	{Key: "OPENROUTER_MODEL", Label: "OpenRouter model (default openrouter/auto; any publisher/model id)"},
	{Key: "OPENROUTER_BASE_URL", Label: "OpenRouter base URL", URL: true},
	{Key: "OPENROUTER_HTTP_REFERER", Label: "OpenRouter app URL for rankings (optional)", URL: true},
	{Key: "OPENROUTER_APP_TITLE", Label: "OpenRouter app title for rankings (optional)"},
	{Key: "TYPESAFE_API_KEY", Label: "TypeSafe API key for Jev verdicts (optional)", Secret: true},
	{Key: "TYPESAFE_MODEL", Label: "Jev model (default jev-latest)"},
	{Key: "E2B_API_KEY", Label: "E2B API key", Section: "Tools & voice", Secret: true},
	{Key: "E2B_CODING_TEMPLATE", Label: "E2B template"},
	{Key: "EXA_API_KEY", Label: "Exa search API key", Secret: true},
	{Key: "EXA_BASE_URL", Label: "Exa base URL", URL: true},
	{Key: "ARCHYMEDES_WEB_SEARCH", Label: "Web search without Exa", Choices: webSearchChoices},
	{Key: "BRAVE_SEARCH_API_KEY", Label: "Brave Search API key", Secret: true},
	{Key: "TAVILY_API_KEY", Label: "Tavily API key", Secret: true},
	{Key: "SEARXNG_URL", Label: "SearXNG instance URL (JSON output enabled)", URL: true},
	{Key: "VOICE_TRANSCRIPTION_URL", Label: "Speech-to-text URL", URL: true},
	{Key: "VOICE_MODEL", Label: "Speech-to-text model"},
	{Key: "VOICE_INPUT_DEVICE", Label: "Microphone device override"},
	{Key: "MODEL_INPUT_PER_MILLION", Label: "Input price per million tokens", Section: "Price overrides"},
	{Key: "MODEL_OUTPUT_PER_MILLION", Label: "Output price per million tokens"},
	{Key: "MODEL_CACHED_INPUT_PER_MILLION", Label: "Cached input price per million tokens"},
	{Key: "MODEL_PRICE_CURRENCY", Label: "Model price currency"},
	{Key: "MODEL_PRICE_MODEL", Label: "Model the price override applies to"},
}

var codeColorChoices = []Choice{
	{"vscode", "VS Code colours — Dark+ or Light+ to match the theme (default)"},
	{"theme", "Theme colours — code painted in the theme's own palette"},
}

var showHideChoices = []Choice{
	{"on", "On (default)"},
	{"off", "Off"},
}

var simpleChoices = []Choice{
	{"on", "On — a quiet start and a short /help (default)"},
	{"off", "Off — the full banner, tips and grouped help"},
}

var reasoningChoices = []Choice{
	{"auto", "Auto (experimental) — lower the effort on routine steps, leave hard ones to the model"},
	{"minimal", "Minimal — never think more than needed"},
	{"low", "Low"},
	{"medium", "Medium"},
	{"high", "High"},
	{"xhigh", "Extra high — deeper than high, for hard problems"},
	{"max", "Max — the deepest the model offers, and the slowest"},
}

var resumeChoices = []Choice{
	{"ask", "Ask — offer to continue the last chat in this folder (default)"},
	{"always", "Always — continue the last chat automatically"},
	{"never", "Never — always start fresh"},
}

var engineChoices = []Choice{
	{"go", "Go — Friday's engine: background sub-agents, steering, restart-safe sessions (default)"},
	{"ts", "TypeScript — the earlier engine: Codex, sandboxes, /undo, /cost, /review"},
}

var autosaveChoices = []Choice{
	{"off", "Off — save with ctrl+s (default)"},
	{"on", "On — save a second after you stop typing"},
}

var suggestChoices = []Choice{
	{"on", "On — next steps after a turn, notes on edits, hints while typing (default)"},
	{"off", "Off — no suggestions"},
}

var onOffChoices = []Choice{
	{"off", "Off — rule-based suggestions only"},
	{"on", "On — the model may add up to two more"},
}

var autoUpdateChoices = []Choice{
	{"install", "Check daily and install automatically (default)"},
	{"check", "Check daily and tell me only"},
	{"off", "Never check"},
}

var testFirstChoices = []Choice{
	{"on", "On — tests that define done, then the code, then a light static check (default)"},
	{"off", "Off — verify with whatever the change needs"},
}

var jevChoices = []Choice{
	{"on", "On — judge turns, suggestions and edits when TYPESAFE_API_KEY is set (default)"},
	{"off", "Off — never call Jev, even with a key configured"},
}

var sandboxChoices = []Choice{
	{"off", "Off — commands run as you would run them (default)"},
	{"on", "On — writes only in the project and /tmp, no network; a way out is asked for each time"},
}

var sandboxNetworkChoices = []Choice{
	{"off", "Off — no network inside the sandbox (default)"},
	{"on", "On — sandboxed commands may use the network"},
}

var tokenSaverChoices = []Choice{
	{"on", "On — trim prompts and history to stretch free limits (default)"},
	{"off", "Off — send everything, as with a paid model"},
}

var tokenMeterChoices = []Choice{
	{"on", "On — show tokens used in the status line"},
	{"off", "Off"},
}

var webSearchChoices = []Choice{
	{"auto", "Automatic — any key set below, else DuckDuckGo, then Stack Overflow (default)"},
	{"brave", "Brave Search only (needs its key)"},
	{"tavily", "Tavily only (needs its key)"},
	{"searxng", "SearXNG only (needs its URL)"},
	{"duckduckgo", "DuckDuckGo, then Stack Overflow (no key)"},
	{"off", "Off — no web search without Exa"},
}

// telemetryChoices had the suggestion words (onOffChoices) in the TypeScript list; its own since WS-50.2.
var telemetryChoices = []Choice{
	{"on", "On — one anonymous cue when a new version first runs (default)"},
	{"off", "Off — nothing is sent"},
}

var notifyChoices = []Choice{
	{"auto", "Auto — only while the terminal is not focused (default)"},
	{"always", "Always — even while you are looking"},
	{"off", "Off — no notifications"},
}

var vimChoices = []Choice{
	{"off", "Off — the input types as it always has (default)"},
	{"on", "On — esc enters normal mode; hjkl, w, b, dd, cw, p, u and the rest"},
}
