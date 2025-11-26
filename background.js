// Cross-browser namespace
const API = (typeof browser !== "undefined") ? browser : chrome;

// Limit for non-premium users
const DAILY_LIMIT = 30;

// Handle toolbar button click
API.action.onClicked.addListener((tab) => {
    // Show loading badge
    try {
        API.action.setBadgeText({ tabId: tab.id, text: '...' });
        API.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#4285F4' });
    } catch (e) {
        // Firefox Android may not support badge background color
    }

    API.tabs.sendMessage(tab.id, { action: 'summarizeHeadlines' });
});

// Listen for messages from content scripts
API.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {

        case 'fetchContent':
            fetch(request.url)
                .then(res => res.text())
                .then(html => {
                    if (html.includes("Please enable JS and disable any ad blocker")) {
                        // Retry fetch inside page context
                        API.scripting.executeScript({
                            target: { tabId: sender.tab.id },
                            func: (url) => new Promise((resolve, reject) => {
                                const fetchContent = () => fetch(url)
                                    .then(r => r.text()).then(resolve).catch(err => reject(err));
                                const checkReadyState = () => {
                                    if (document.readyState === 'complete') fetchContent();
                                    else setTimeout(checkReadyState, 100);
                                };
                                checkReadyState();
                            }),
                            args: [request.url]
                        }, results => {
                            if (results?.[0]?.result) sendResponse({ html: results[0].result });
                            else sendResponse({ error: 'Error fetching article content' });
                        });
                    } else sendResponse({ html });
                })
                .catch(err => sendResponse({ error: err.message }));
            return true;

        case 'AIcall':
            handleAICall(request, sendResponse);
            return true;

        case 'checkPremium':
            API.storage.sync.get(['premium'], r => sendResponse({ premium: !!r.premium }));
            return true;

        case 'headlineChanged':
            if (sender.tab?.id != null) API.action.setBadgeText({ tabId: sender.tab.id, text: '' });
            sendResponse({ status: 'badge cleared' });
            return true;

        case 'checkDailyLimit':
            checkDailyLimit(sendResponse);
            return true;

        case 'incrementDailyCount':
            incrementDailyCount(sendResponse);
            return true;
    }
});

// ----------------------
// Helper functions
// ----------------------

function handleAICall(request, sendResponse) {
    const { apiKey, model, apiProvider = "groq", prompt } = request;
    const systemPrompt = request.systemPrompt?.trim() || "Generate an objective, non-clickbait headline...";
    let baseURL, body, headers;

    switch (apiProvider) {
        case "claude":
            baseURL = "https://api.anthropic.com/v1/messages";
            body = JSON.stringify({ model, max_tokens: 300, system: systemPrompt, messages: [{ role: "user", content: prompt }] });
            headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
            break;
        case "gemini":
            baseURL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
            headers = { "Content-Type": "application/json", "x-goog-api-key": apiKey };
            break;
        case "openai":
        case "groq":
        default:
            baseURL = apiProvider === "openai"
                ? "https://api.openai.com/v1/chat/completions"
                : "https://api.groq.com/openai/v1/chat/completions";
            body = JSON.stringify({
                model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt }
                ],
                temperature: 0.0,
                max_tokens: 300,
                top_p: 0.4
            });
            headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
            break;
    }

    fetch(baseURL, { method: "POST", headers, body })
        .then(res => {
            if (!res.ok) {
                if (res.status === 429) throw new Error(`Rate limit. Retry in ${res.headers.get('retry-after') || 'a few'}s`);
                if (res.status === 401) throw new Error('Invalid API key');
                throw new Error('Error fetching summary');
            }
            return res.json();
        })
        .then(data => {
            let summary = "";
            if (apiProvider === "claude") summary = data.content?.[0]?.text || data.completion || "";
            else if (apiProvider === "gemini") summary = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            else summary = data.choices?.[0]?.message?.content || "";
            sendResponse({ summary });
        })
        .catch(err => sendResponse({ error: err.message }));
}

function checkDailyLimit(sendResponse) {
    const today = new Date().toDateString();
    API.storage.local.get(['dailyUsage'], result => {
        const usage = result.dailyUsage || {};
        for (const k of Object.keys(usage)) if (k !== today) delete usage[k];
        const count = usage[today] || 0;
        sendResponse({ canProceed: count < DAILY_LIMIT, count, reason: count >= DAILY_LIMIT ? 'dailyLimit' : null });
    });
}

function incrementDailyCount(sendResponse) {
    const today = new Date().toDateString();
    API.storage.local.get(['dailyUsage'], result => {
        const usage = result.dailyUsage || {};
        usage[today] = (usage[today] || 0) + 1;
        API.storage.local.set({ dailyUsage: usage }, () => {
            sendResponse({ limitReached: usage[today] >= DAILY_LIMIT, count: usage[today] });
        });
    });
}

// ----------------------
// External message listener
// ----------------------

const REQUIRED_TOKEN = 'e23de-32dd3-d2fg3fw-f34f3w';

API.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (message.type === "activatePremium" && message.token === REQUIRED_TOKEN) {
        API.storage.sync.set({ premium: true }, () => console.log('Premium unlocked!'));
        if (API.runtime.openOptionsPage) {
            setTimeout(() => API.runtime.openOptionsPage(), 3000);
        }
        sendResponse({ status: 'success' });
        return true;
    }
});
