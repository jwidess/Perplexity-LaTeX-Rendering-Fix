// ==UserScript==
// @name         Perplexity LaTeX Rendering Fix
// @namespace    https://github.com/jwidess/Perplexity-LaTeX-Rendering-Fix
// @version      4.0
// @description  Intercepts API responses and fixes ($...$) to the correct format (\(...\)) for LaTeX rendering
// @author       Jwidess
// @match        https://www.perplexity.ai/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // Function to convert LaTeX syntax
    function fixLatexSyntax(text) {
        if (typeof text !== 'string') return text;

        // Replace $...$ with \(...\) but preserve $$...$$
        return text.replace(/(?<!\$)\$(?!\$)([^\$]+?)\$(?!\$)/g, '\\($1\\)');
    }

    // Recursively fix LaTeX in objects
    function fixObjectLatex(obj) {
        if (typeof obj === 'string') {
            return fixLatexSyntax(obj);
        }

        if (Array.isArray(obj)) {
            return obj.map(item => fixObjectLatex(item));
        }

        if (obj && typeof obj === 'object') {
            const fixed = {};
            for (let key in obj) {
                if (obj.hasOwnProperty(key)) {
                    fixed[key] = fixObjectLatex(obj[key]);
                }
            }
            return fixed;
        }

        return obj;
    }

    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);

        // Clone the response to read
        const clonedResponse = response.clone();

        try {
            const contentType = response.headers.get('content-type');

            // Only JSON responses
            if (contentType && contentType.includes('application/json')) {
                const data = await clonedResponse.json();
                const fixedData = fixObjectLatex(data);

                // Return new response with fixed data
                return new Response(JSON.stringify(fixedData), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            }

            // For streaming responses (text/event-stream)
            if (contentType && contentType.includes('text/event-stream')) {
                const reader = clonedResponse.body.getReader();
                const decoder = new TextDecoder();

                const stream = new ReadableStream({
                    async start(controller) {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            let text = decoder.decode(value, { stream: true });
                            text = fixLatexSyntax(text);

                            controller.enqueue(new TextEncoder().encode(text));
                        }
                        controller.close();
                    }
                });

                return new Response(stream, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            }
        } catch (e) {
            console.log('LaTeX fix error:', e);
        }

        return response;
    };

    // Intercept XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(...args) {
        this._url = args[1];
        return originalOpen.apply(this, args);
    };

    XMLHttpRequest.prototype.send = function(...args) {
        const xhr = this;

        const originalOnReadyStateChange = xhr.onreadystatechange;
        xhr.onreadystatechange = function() {
            if (xhr.readyState === 4 && xhr.responseText) {
                try {
                    const contentType = xhr.getResponseHeader('content-type');
                    if (contentType && contentType.includes('application/json')) {
                        const data = JSON.parse(xhr.responseText);
                        const fixedData = fixObjectLatex(data);

                        Object.defineProperty(xhr, 'responseText', {
                            writable: true,
                            value: JSON.stringify(fixedData)
                        });
                        Object.defineProperty(xhr, 'response', {
                            writable: true,
                            value: JSON.stringify(fixedData)
                        });
                    }
                } catch (e) {
                    // Ignore, not JSON or other error
                }
            }

            if (originalOnReadyStateChange) {
                return originalOnReadyStateChange.apply(this, arguments);
            }
        };

        return originalSend.apply(this, args);
    };

    console.log('Perplexity LaTeX fixer v4.0 loaded - intercepting network requests');
})();