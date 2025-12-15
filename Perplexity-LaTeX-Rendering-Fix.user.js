// ==UserScript==
// @name         Perplexity LaTeX Rendering Fix
// @namespace    https://github.com/jwidess/Perplexity-LaTeX-Rendering-Fix
// @version      5.2
// @description  Intercepts API responses and fixes ($...$) to the correct format (\(...\)) for LaTeX rendering
// @author       Jwidess
// @match        https://www.perplexity.ai/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const DEBUG = false;
    const STATS = { processed: 0, modified: 0, errors: 0 };
    
    // Track if modifications were made in current processing
    let hasModifications = false;

    // Function to convert LaTeX syntax
    function fixLatexSyntax(text) {
        if (typeof text !== 'string' || !text.includes('$')) return text;
        
        // Skip if it already has \( or if it's a URL/code
        if (text.includes('\\(') || text.includes('http://') || text.includes('https://')) {
            return text;
        }
        
        // Skip very long strings
        if (text.length > 10000) return text;
        
        const original = text;
        
        // Replace $...$ with \(...\) but preserve $$...$$
        // Negative lookbehind/ahead to avoid matching $$
        const fixed = text.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g, (match, p1) => {
            // check if content looks like math
            const words = p1.split(/\s+/);
            
            // If it has more than 15 words, it's probably not inline math
            if (words.length > 15) {
                return match; // Keep original
            }
  
            return `\\(${p1}\\)`;
        });
        
        if (original !== fixed) {
            STATS.modified++;
            hasModifications = true;
            if (DEBUG) {
                console.log('LaTeX fixed:', { original: original.substring(0, 100), fixed: fixed.substring(0, 100) });
            }
        }
        
        return fixed;
    }

    // Recursively fix LaTeX in objects
    function fixObjectLatex(obj, depth = 0) {
        // prevent infinite recursion
        if (depth > 10) return obj;
        
        if (typeof obj === 'string') {
            STATS.processed++;
            return fixLatexSyntax(obj);
        }
        
        if (Array.isArray(obj)) {
            return obj.map(item => fixObjectLatex(item, depth + 1));
        }
        
        if (obj && typeof obj === 'object') {
            // don't process system objects
            if (obj instanceof Blob || obj instanceof File || obj instanceof ArrayBuffer) {
                return obj;
            }
            
            const fixed = {};
            for (let key in obj) {
                if (obj.hasOwnProperty(key)) {
                    // Skip keys that shouldn't be modified
                    if (key === 'url' || key === 'href' || key === 'src' || key === 'id' || key === 'token') {
                        fixed[key] = obj[key];
                    } else {
                        fixed[key] = fixObjectLatex(obj[key], depth + 1);
                    }
                }
            }
            return fixed;
        }
        
        return obj;
    }

    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        try {
            const response = await originalFetch.apply(this, args);
            const url = args[0]?.toString() || 'unknown';
            
            // only process Perplexity API
            if (!url.includes('perplexity') && !url.startsWith('/')) {
                return response;
            }
            
            const clonedResponse = response.clone();
            const contentType = response.headers.get('content-type') || '';
            
            // Process JSON responses
            if (contentType.includes('application/json')) {
                try {
                    const data = await clonedResponse.json();
                    hasModifications = false; // Reset flag
                    const fixedData = fixObjectLatex(data);
                    
                    // Only return modified response if we actually made changes
                    if (hasModifications) {
                        if (DEBUG) {
                            console.log('Processed and modified JSON from:', url);
                        }
                        
                        return new Response(JSON.stringify(fixedData), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    }
                    
                    // No changes made, return original response
                    return response;
                } catch (e) {
                    STATS.errors++;
                    if (DEBUG) console.error('JSON processing error:', e);
                    return response;
                }
            }
            
            // Process streaming responses
            if (contentType.includes('text/event-stream') || contentType.includes('text/plain')) {
                try {
                    const reader = clonedResponse.body.getReader();
                    const decoder = new TextDecoder();
                    
                    const stream = new ReadableStream({
                        async start(controller) {
                            try {
                                while (true) {
                                    const { done, value } = await reader.read();
                                    if (done) break;
                                    
                                    let text = decoder.decode(value, { stream: true });
                                    text = fixLatexSyntax(text);
                                    
                                    controller.enqueue(new TextEncoder().encode(text));
                                }
                                controller.close();
                            } catch (e) {
                                STATS.errors++;
                                controller.error(e);
                            }
                        }
                    });
                    
                    if (DEBUG) {
                        console.log('Processed stream from:', url);
                    }
                    
                    return new Response(stream, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                    });
                } catch (e) {
                    STATS.errors++;
                    if (DEBUG) console.error('Stream processing error:', e);
                    return response;
                }
            }
            
            return response;
        } catch (e) {
            STATS.errors++;
            if (DEBUG) console.error('Fetch intercept error:', e);
            return originalFetch.apply(this, args);
        }
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
        const url = xhr._url || 'unknown';
        
        // Only process Perplexity endpoints
        if (!url.includes('perplexity') && !url.startsWith('/')) {
            return originalSend.apply(this, args);
        }
        
        const originalOnReadyStateChange = xhr.onreadystatechange;
        xhr.onreadystatechange = function() {
            if (xhr.readyState === 4 && xhr.responseText) {
                try {
                    const contentType = xhr.getResponseHeader('content-type') || '';
                    if (contentType.includes('application/json')) {
                        const data = JSON.parse(xhr.responseText);
                        hasModifications = false; // Reset flag
                        const fixedData = fixObjectLatex(data);
                        
                        // Only modify response if changes were made
                        if (hasModifications) {
                            Object.defineProperty(xhr, 'responseText', {
                                writable: true,
                                value: JSON.stringify(fixedData)
                            });
                            Object.defineProperty(xhr, 'response', {
                                writable: true,
                                value: JSON.stringify(fixedData)
                            });
                            
                            if (DEBUG) {
                                console.log('Processed and modified XHR from:', url);
                            }
                        }
                    }
                } catch (e) {
                    STATS.errors++;
                    if (DEBUG) console.error('XHR processing error:', e);
                }
            }
            
            if (originalOnReadyStateChange) {
                return originalOnReadyStateChange.apply(this, arguments);
            }
        };
        
        return originalSend.apply(this, args);
    };

    // Log stats
    setInterval(() => {
        if (STATS.modified > 0 || DEBUG) {
            console.log('LaTeX Fixer Stats:', STATS);
        }
    }, 30000); // Every 30s

    // Stats and toggle debug via console
    window.latexFixerStats = () => {
        console.log('LaTeX Fixer Statistics:', STATS);
        console.log('To enable debug mode, run: window.latexFixerDebug = true');
    };

    console.log('Perplexity LaTeX fixer v5.2 loaded');
    console.log('Run latexFixerStats() in console to see statistics');
})();
