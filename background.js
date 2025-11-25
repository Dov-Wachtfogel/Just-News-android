// Cross-browser namespace
const API = chrome ?? browser;

// limit for non-premium users
const DAILY_LIMIT = 30;

API.action.onClicked.addListener((tab) => {
    // Show loading badge
    API.action.setBadgeText({ tabId: tab.id, text: '...' });
    try {
        API.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#4285F4' });
    } catch (e) {
        // Firefox Android does not support badge background color
    }
    API.tabs.sendMessage(tab.id, { action: 'summarizeHeadlines' });
});

const dl = 5 * 6;

// Listen for messages from the content script
API.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchContent') {

        fetch(request.url)
            .then(response => response.text())
            .then(html => {
                if (html.includes("Please enable JS and disable any ad blocker")) {

                    API.scripting.executeScript(
                        {
                            target: { tabId: sender.tab.id },
                            func: (url) => {
                                return new Promise((resolve, reject) => {
                                    const fetchContent = () => {
                                        fetch(url)
                                            .then(response => response.text())
                                            .then(html => resolve(html))
                                            .catch(err => reject(err.message));
                                    };
                                    const checkReadyState = () => {
                                        if (document.readyState === 'complete') {
                                            fetchContent();
                                        } else {
                                            setTimeout(checkReadyState, 100);
                                        }
                                    };
                                    checkReadyState();
                                });
                            },
                            args: [request.url],
                        },
                        (results) => {
                            if (results?.[0]?.result) {
                                sendResponse({ html: results[0].result });
                            } else {
                                sendResponse({ error: 'Error fetching article content' });
                            }
                        }
                    );

                } else {
                    sendResponse({ html });
                }
            })
            .catch(error => sendResponse({ error: error.message }));

        return true;
    }

    else if (request.action === 'AIcall') {
        const apiKey = request.apiKey;
        const model = request.model;
        const apiProvider = request.apiProvider || "groq";

        const systemPrompt =
            request.systemPrompt?.trim()?.length > 0
                ? request.systemPrompt
                : `Generate an objective, non-clickbait headline...`;

        let baseURL;

        if (apiProvider === "groq") {
            baseURL = "https://api.groq.com/openai/v1/chat/completions";
        } else if (apiProvider === "openai") {
            baseURL = "https://api.openai.com/v1/chat/completions";
        } else if (apiProvider === "claude") {
            baseURL = "https://api.anthropic.com/v1/messages";
        } else if (apiProvider === "gemini") {
            baseURL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        } else {
            baseURL = "https://api.groq.com/openai/v1/chat/completions";
        }

        let prompt = request.prompt;
        console.log(prompt);

        let body, headers;

        if (apiProvider === "claude") {
            body = JSON.stringify({
                model,
                max_tokens: 300,
                system: systemPrompt,
                messages: [{ role: "user", content: prompt }]
            });
            headers = {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01"
            };
        }

        else if (apiProvider === "gemini") {
            body = JSON.stringify({
                contents: [{ role: "user", parts: [{ text: prompt }] }]
            });
            headers = {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey
            };
        }

        else {
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
            headers = {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            };
        }

        fetch(baseURL, {
            method: "POST",
            headers,
            body
        })
            .then(response => {
                if (!response.ok) {
                    if (response.status === 429)
                        throw new Error(`Rate limit. Retry in ${response.headers.get('retry-after') || 'a few'} seconds`);
                    if (response.status === 401)
                        throw new Error('Invalid API key');
                    throw new Error('Error fetching summary');
                }
                return response.json();
            })
            .then(data => {
                let summary;
                if (apiProvider === "claude") {
                    summary = data.content?.[0]?.text || data.completion || "";
                } else if (apiProvider === "gemini") {
                    summary = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
                } else {
                    summary = data.choices?.[0]?.message?.content || "";
                }
                sendResponse({ summary });
            })
            .catch(error => sendResponse({ error: error.message }));

        return true;
    }

    else if (request.action === 'checkPremium') {
        API.storage.sync.get(['premium'], r =>
            sendResponse({ ipb: !!r.premium })
        );
        return true;
    }

    else if (request.action === 'headlineChanged') {
        API.action.setBadgeText({ tabId: sender.tab.id, text: '' });
        sendResponse({ status: 'badge cleared' });
        return;
    }

    else if (request.action === 'checkDailyLimit') {
        const today = new Date().toDateString();

        API.storage.local.get(['dailyUsage'], result => {
            try {
                const usage = result.dailyUsage || {};

                // Cleanup
                for (const k of Object.keys(usage)) {
                    if (k !== today) delete usage[k];
                }

                const count = usage[today] || 0;

                sendResponse({
                    canProceed: count < dl,
                    count,
                    reason: count >= dl ? 'dailyLimit' : null
                });
            } catch (e) {
                sendResponse({ error: e.message });
            }
        });

        return true;
    }

    if (request.action === 'incrementDailyCount') {
        const today = new Date().toDateString();

        API.storage.local.get(['dailyUsage'], result => {
            const usage = result.dailyUsage || {};
            usage[today] = (usage[today] || 0) + 1;

            API.storage.local.set({ dailyUsage: usage }, () => {
                sendResponse({
                    limitReached: usage[today] >= dl,
                    count: usage[today]
                });
            });
        });

        return true;
    }
});

// External messaging
const REQUIRED_TOKEN = 'e23de-32dd3-d2fg3fw-f34f3w';

API.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (message.type === "activatePremium" && message.token == REQUIRED_TOKEN) {

        API.storage.sync.set({ premium: true }, () => {
            console.log('Premium unlocked!');
        });

        setTimeout(() => {
            API.runtime.openOptionsPage();
        }, 10000);

        return true;
    }
});
