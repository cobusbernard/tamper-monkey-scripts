// ==UserScript==
// @name         USCIS Case Tracker
// @namespace    http://tampermonkey.net/
// @version      0.5
// @description  Track USCIS case changes with local storage and history
// @author       Cobus Bernard
// @match        https://my.uscis.gov/account/applicant*
// @grant        none
// @icon         https://www.google.com/s2/favicons?sz=64&domain=cobus.io
// @updateURL    https://raw.githubusercontent.com/cobusbernard/tamper-monkey-scripts/main/uscis-tracker/uscis-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/cobusbernard/tamper-monkey-scripts/main/uscis-tracker/uscis-tracker.user.js
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'uscis_cases_data';
    const HISTORY_KEY = 'uscis_cases_history';
    const API_URL = 'https://my.uscis.gov/account/case-service/api/cases';
    const EVENT_CODES = new Map([
        ['IAF', 'Receipt letter emailed'],
        ['FTA0', 'Biometrics / database checks received'],
        ['SA', 'Status Adjusted'],
        ['LDA', 'Card Produced'],
        ['H008', 'Case Approved'],
        ['H016', 'Case Denied'],
        ['IKA', 'RFE issued']
    ]);

    let caseIdsHidden = true;
    let currentCaseData = {};
    let fieldHighlights = {};

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function escapeHtml(str) {
        if (str == null) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function getEventCodeDescription(key) {
        const normalizedKey = key.toUpperCase();
        return EVENT_CODES.get(normalizedKey) ?? "Unknown";
    }

    function extractCaseNumbersFromDOM() {
        const pageText = document.body.innerText;
        const matches = pageText.match(/IOE\d+/g);
        return matches ? Array.from(new Set(matches)) : [];
    }

    async function fetchCaseData(caseNumber) {
        try {
            const statusResponse = await fetch(`${API_URL}/${caseNumber}`);
            const statusData = await statusResponse.json();

            const docResponse = await fetch(`${API_URL}/${caseNumber}/documents`);
            const documentsData = await docResponse.json();

            const caseInfo = statusData.data || {};

            const sortedEvents = (caseInfo.events || [])
                .map(event => ({
                    eventCode: event.eventCode,
                    eventDesc: getEventCodeDescription(event.eventCode),
                    updatedAtTimestamp: event.updatedAtTimestamp
                }))
                .sort((a, b) => new Date(b.updatedAtTimestamp) - new Date(a.updatedAtTimestamp));

            return {
                caseNumber,
                formType: caseInfo.formType,
                formName: caseInfo.formName,
                closed: caseInfo.closed,
                updatedAt: caseInfo.updatedAt,
                updatedAtTimestamp: caseInfo.updatedAtTimestamp,
                currentActionCode: sortedEvents[0]?.eventCode,
                currentActionDesc: sortedEvents[0]?.eventDesc,
                events: sortedEvents,
                documents: documentsData,
                lastFetched: new Date().toISOString()
            };
        } catch (error) {
            console.error(`Error fetching case ${caseNumber}:`, error);
            return null;
        }
    }

    // --- History Management ---

    function getHistory() {
        return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    }

    function getLastSavedCases() {
        const history = getHistory();
        if (history.length > 0) {
            return history[history.length - 1].cases;
        }
        // Migrate from legacy single-snapshot format
        const legacy = localStorage.getItem(STORAGE_KEY);
        if (legacy) {
            const parsed = JSON.parse(legacy);
            return parsed.cases || {};
        }
        return {};
    }

    function saveToHistory(casesData) {
        const history = getHistory();
        history.push({
            cases: casesData,
            savedAt: new Date().toISOString()
        });
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            cases: casesData,
            lastFetch: new Date().toISOString()
        }));
    }

    function clearAllHistory() {
        localStorage.removeItem(HISTORY_KEY);
        localStorage.removeItem(STORAGE_KEY);
    }

    // --- Change Detection ---

    function detectFieldHighlights(oldCases, newCases) {
        const highlights = {};
        Object.keys(newCases).forEach(caseNum => {
            highlights[caseNum] = {
                isNew: false,
                updatedAtChanged: false,
                newEventIndices: new Set()
            };
            if (!oldCases[caseNum]) {
                highlights[caseNum].isNew = true;
                highlights[caseNum].updatedAtChanged = true;
                newCases[caseNum].events.forEach((_, i) => {
                    highlights[caseNum].newEventIndices.add(i);
                });
            } else {
                if (oldCases[caseNum].updatedAtTimestamp !== newCases[caseNum].updatedAtTimestamp ||
                    oldCases[caseNum].updatedAt !== newCases[caseNum].updatedAt) {
                    highlights[caseNum].updatedAtChanged = true;
                }
                const oldEventKeys = new Set(
                    (oldCases[caseNum].events || []).map(e => `${e.eventCode}_${e.updatedAtTimestamp}`)
                );
                (newCases[caseNum].events || []).forEach((event, i) => {
                    const key = `${event.eventCode}_${event.updatedAtTimestamp}`;
                    if (!oldEventKeys.has(key)) {
                        highlights[caseNum].newEventIndices.add(i);
                    }
                });
            }
        });
        return highlights;
    }

    // --- Display Helpers ---

    function formatDate(dateString) {
        if (!dateString) return 'Unknown';
        try {
            const date = new Date(dateString);
            return date.toLocaleString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        } catch (e) {
            return dateString;
        }
    }

    function maskCaseId(caseId) {
        return caseId.replace(/\d/g, '*');
    }

    function displayCaseId(caseId) {
        return caseIdsHidden ? maskCaseId(caseId) : caseId;
    }

    function daysBetween(date1, date2) {
        return Math.floor(Math.abs(new Date(date1) - new Date(date2)) / (1000 * 60 * 60 * 24));
    }

    // --- DOM Construction Helpers ---

    function el(tag, styles, children) {
        const element = document.createElement(tag);
        if (styles) Object.assign(element.style, styles);
        if (children) {
            if (typeof children === 'string') {
                element.textContent = children;
            } else if (Array.isArray(children)) {
                children.forEach(child => {
                    if (child) element.appendChild(child);
                });
            } else {
                element.appendChild(children);
            }
        }
        return element;
    }

    function textNode(text) {
        return document.createTextNode(text);
    }

    // --- Timeline Rendering ---

    function renderTimelineEvent(event, i, events, caseHighlights) {
        const isOldest = i === events.length - 1;
        const isHighlighted = caseHighlights?.newEventIndices?.has(i);
        const circleContent = isOldest ? '' : `${String(daysBetween(event.updatedAtTimestamp, events[i + 1].updatedAtTimestamp))}d`;
        const accent = isHighlighted ? '#00a000' : '#0066cc';
        const textColor = isHighlighted ? '#00a000' : '#666';

        const circle = el('div', {
            width: '28px', height: '28px', borderRadius: '50%',
            border: `2px solid ${accent}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '9px', fontWeight: 'bold', color: accent,
            background: 'white', flexShrink: '0'
        }, circleContent);

        const timelineCol = el('div', {
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            width: '36px', flexShrink: '0'
        }, [circle]);

        if (!isOldest) {
            timelineCol.appendChild(el('div', {
                width: '2px', flex: '1', minHeight: '8px', background: '#b0d0e8'
            }));
        }

        const eventLabel = el('strong', { color: accent },
            `${escapeHtml(event.eventCode)} - ${escapeHtml(event.eventDesc)}`);
        const eventDate = el('span', { color: textColor }, formatDate(event.updatedAtTimestamp));

        const content = el('div', {
            marginLeft: '8px', paddingBottom: isOldest ? '0' : '12px', flex: '1'
        });
        content.appendChild(eventLabel);
        content.appendChild(document.createElement('br'));
        content.appendChild(eventDate);

        return el('div', { display: 'flex', alignItems: 'stretch' }, [timelineCol, content]);
    }

    function renderTimeline(events, caseHighlights) {
        if (!events || events.length === 0) {
            return el('em', {}, 'No events');
        }
        const container = el('div', {});
        events.forEach((event, i) => {
            container.appendChild(renderTimelineEvent(event, i, events, caseHighlights));
        });
        return container;
    }

    // --- Case Card Rendering ---

    function renderCaseCard(caseNum, caseData, highlights) {
        const updatedAtColor = highlights.updatedAtChanged ? '#00a000' : '#333';

        const card = el('div', {
            padding: '12px', margin: '0 0 10px 0', background: '#f0f8ff',
            borderLeft: '4px solid #0066cc', borderRadius: '4px'
        });

        const closedLabel = caseData.closed ? ' (Closed)' : '';
        const title = el('strong', { color: '#0066cc' },
            `${escapeHtml(displayCaseId(caseNum))} - ${escapeHtml(caseData.formType)}${closedLabel}`);
        card.appendChild(title);
        card.appendChild(document.createElement('br'));

        const form = el('small', { color: '#333' });
        form.appendChild(el('strong', {}, 'Form: '));
        form.appendChild(textNode(escapeHtml(caseData.formName)));
        card.appendChild(form);
        card.appendChild(document.createElement('br'));

        const updated = el('small', { color: updatedAtColor });
        updated.appendChild(el('strong', {}, 'Last Updated: '));
        updated.appendChild(textNode(formatDate(caseData.updatedAtTimestamp)));
        card.appendChild(updated);
        card.appendChild(document.createElement('br'));

        const action = el('small', { color: '#333' });
        action.appendChild(el('strong', {}, 'Current Action: '));
        action.appendChild(textNode(
            `${escapeHtml(caseData.currentActionCode)} - ${escapeHtml(caseData.currentActionDesc)}`
        ));
        card.appendChild(action);

        // Events details
        const details = document.createElement('details');
        details.style.marginTop = '8px';
        details.style.cursor = 'pointer';

        const summary = document.createElement('summary');
        summary.style.color = '#0066cc';
        summary.style.fontWeight = 'bold';
        summary.textContent = `Events History (${caseData.events.length})`;
        details.appendChild(summary);

        const eventsContainer = el('div', { marginTop: '8px', padding: '8px 0' });
        eventsContainer.appendChild(renderTimeline(caseData.events, highlights));
        details.appendChild(eventsContainer);

        card.appendChild(details);
        return card;
    }

    // --- Main Pane Rendering ---

    function renderPane() {
        let pane = document.getElementById('uscis-tracker-pane');
        if (!pane) {
            pane = document.createElement('div');
            pane.id = 'uscis-tracker-pane';
            document.body.appendChild(pane);
        }

        Object.assign(pane.style, {
            position: 'fixed',
            top: '80px',
            right: '20px',
            width: '380px',
            maxHeight: 'calc(100vh - 100px)',
            background: 'white',
            border: '2px solid #0066cc',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: '10000',
            fontFamily: 'Arial, sans-serif',
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column'
        });

        // Clear previous content
        pane.replaceChildren();

        // --- Header (non-scrolling) ---
        const header = el('div', {
            padding: '15px 15px 10px 15px',
            borderBottom: '1px solid #e0e0e0',
            flexShrink: '0'
        });

        const heading = el('h3', { margin: '0 0 10px 0', color: '#0066cc' }, 'USCIS Case Status');
        header.appendChild(heading);

        const buttonBar = el('div', { display: 'flex', gap: '8px' });

        const toggleBtn = el('button', {
            padding: '4px 10px', fontSize: '11px', cursor: 'pointer',
            background: '#0066cc', color: 'white', border: 'none', borderRadius: '4px'
        }, caseIdsHidden ? 'Show Case IDs' : 'Hide Case IDs');
        toggleBtn.addEventListener('click', () => {
            caseIdsHidden = !caseIdsHidden;
            renderPane();
        });

        const clearBtn = el('button', {
            padding: '4px 10px', fontSize: '11px', cursor: 'pointer',
            background: '#cc3333', color: 'white', border: 'none', borderRadius: '4px'
        }, 'Clear History');
        clearBtn.addEventListener('click', () => {
            if (confirm('Clear all stored USCIS tracking history?')) {
                clearAllHistory();
            }
        });

        buttonBar.appendChild(toggleBtn);
        buttonBar.appendChild(clearBtn);
        header.appendChild(buttonBar);
        pane.appendChild(header);

        // --- Scrollable content ---
        const content = el('div', {
            padding: '15px', overflowY: 'auto', flex: '1'
        });

        const sortedCaseNumbers = Object.keys(currentCaseData).sort();
        sortedCaseNumbers.forEach(caseNum => {
            const caseData = currentCaseData[caseNum];
            const highlights = fieldHighlights[caseNum] || {};
            content.appendChild(renderCaseCard(caseNum, caseData, highlights));
        });

        pane.appendChild(content);
    }

    // --- Page Load ---

    async function waitForCaseCardsComponent(maxAttempts = 30) {
        await sleep(200);
        for (let i = 0; i < maxAttempts; i++) {
            const caseCardDivs = document.querySelectorAll('[id^="CaseCardsApp-react-component-"]');
            if (caseCardDivs.length > 0) {
                console.log('CaseCardsApp component found');
                return caseCardDivs[0];
            }
            console.log(`Waiting for CaseCardsApp component... attempt ${i + 1}/${maxAttempts}`);
            await sleep(200);
        }
        console.warn('CaseCardsApp component not found after 15 seconds');
        return null;
    }

    // --- Main ---

    async function trackCases() {
        const caseCardsComponent = await waitForCaseCardsComponent();
        if (!caseCardsComponent) {
            console.warn('Could not load case cards component, attempting to extract case numbers anyway');
        }

        const caseNumbers = extractCaseNumbersFromDOM();
        const lastSavedCases = getLastSavedCases();

        const newData = {};
        for (const caseNum of caseNumbers) {
            const caseData = await fetchCaseData(caseNum);
            if (caseData) newData[caseNum] = caseData;
        }

        fieldHighlights = detectFieldHighlights(lastSavedCases, newData);
        currentCaseData = newData;

        renderPane();

        const changes = Object.entries(fieldHighlights).filter(([_, h]) =>
            h.isNew || h.updatedAtChanged || h.newEventIndices.size > 0
        );
        if (changes.length > 0) {
            console.log('USCIS Case Changes Detected:', changes);
        }

        saveToHistory(newData);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', trackCases);
    } else {
        trackCases();
    }
})();
