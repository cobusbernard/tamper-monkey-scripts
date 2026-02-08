// ==UserScript==
// @name         USCIS Case Tracker
// @namespace    http://tampermonkey.net/
// @version      0.4
// @description  Track USCIS case changes with local storage
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
    const API_URL = 'https://my.uscis.gov/account/case-service/api/cases';
    const EVENT_CODES = new Map([
        ['IAF', 'Receipt letter emailed'],
        ['FTA0', 'Biometrics / database checks received'],
        ['SA', 'Status Adjusted'],
        ['LDF', 'Card Produced'],
        ['H008', 'Case Approved'],
        ['H016', 'Case Denied'],
        ['IKA', 'RFE issued']
    ]);

    // Helper function to sleep/delay
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Returns the description for an event code
    function getEventCodeDescription(key) {
        const normalizedKey = key.toUpperCase();
        const lookupKey = EVENT_CODES.get(normalizedKey);

        return lookupKey ?? "Unknown";
    }

    // Wait for page to be fully ready with case data visible
    async function waitForCasesToLoad(maxAttempts = 30) {
        for (let i = 0; i < maxAttempts; i++) {
            const caseNumbers = extractCaseNumbersFromDOM();
            if (caseNumbers.length > 0) {
                return caseNumbers;
            }
            // Wait 500ms before trying again
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        console.warn('Timeout waiting for cases to load');
        return extractCaseNumbersFromDOM(); // Return whatever we have
    }

    // Extract case numbers from the DOM instead of hard-coding
    function extractCaseNumbersFromDOM() {
        const caseNumbers = [];
        const pageText = document.body.innerText;
        const matches = pageText.match(/IOE\d+/g);
        if (matches) {
            return Array.from(new Set(matches)); // Remove duplicates
        }
        return caseNumbers;
    }

    // Fetch individual case data
    async function fetchCaseData(caseNumber) {
        try {

            const statusResponse = await fetch(`${API_URL}/${caseNumber}`);
            const statusData = await statusResponse.json();

            const docResponse = await fetch(`${API_URL}/${caseNumber}/documents`);
            const documentsData = await docResponse.json();

            // Extract the relevant data
            const caseInfo = statusData.data || {};

            // Sort events in descending order by date (most recent first)
            const sortedEvents = (caseInfo.events || [])
                .map(event => ({
                    eventCode: event.eventCode,
                    eventDesc: getEventCodeDescription(event.eventCode),
                    updatedAtTimestamp: event.updatedAtTimestamp
                }))
                .sort((a, b) => {
                    // Parse dates and sort in descending order (newest first)
                    const dateA = new Date(a.updatedAtTimestamp).getTime();
                    const dateB = new Date(b.updatedAtTimestamp).getTime();
                    return dateB - dateA;
                });

            return {
                caseNumber: caseNumber,
                formType: caseInfo.formType,
                formName: caseInfo.formName,
                updatedAtTimestamp: caseInfo.updatedAtTimestamp,
                currentActionCode: sortedEvents[0].eventCode,
                currentActionDesc: sortedEvents[0].eventDesc,
                events: sortedEvents,
                documents: documentsData,
                lastFetched: new Date().toISOString()
            };
        } catch (error) {
            console.error(`Error fetching case ${caseNumber}:`, error);
            return null;
        }
    }

    // Load stored data
    function getStoredData() {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored ? JSON.parse(stored) : { cases: {}, lastFetch: null };
    }

    // Compare and detect changes
    function detectChanges(oldData, newData) {
        const changes = [];

        Object.keys(newData).forEach(caseNum => {
            if (!oldData[caseNum]) {
                changes.push({
                    caseNum,
                    type: 'NEW',
                    data: newData[caseNum],
                    changeDetails: 'New case added'
                });
            } else {
                // Check if case was updated
                if (oldData[caseNum].updatedAtTimestamp !== newData[caseNum].updatedAtTimestamp) {
                    changes.push({
                        caseNum,
                        type: 'UPDATED',
                        data: newData[caseNum],
                        oldTimestamp: oldData[caseNum].updatedAtTimestamp,
                        changeDetails: `Case updated from ${oldData[caseNum].updatedAtTimestamp} to ${newData[caseNum].updatedAtTimestamp}`
                    });
                }
                // Check if new events were added
                const oldEventCount = (oldData[caseNum].events || []).length;
                const newEventCount = (newData[caseNum].events || []).length;
                if (newEventCount > oldEventCount) {
                    const newEvents = newData[caseNum].events.slice(0, newEventCount - oldEventCount);
                    changes.push({
                        caseNum,
                        type: 'NEW_EVENTS',
                        data: newData[caseNum],
                        newEvents: newEvents,
                        changeDetails: `${newEventCount - oldEventCount} new event(s) added`
                    });
                }
            }
        });

        return changes;
    }

    // Create notification pane with detailed info
    function createNotificationPane(allCaseData) {
        let pane = document.getElementById('uscis-tracker-pane');
        if (!pane) {
            pane = document.createElement('div');
            pane.id = 'uscis-tracker-pane';
            pane.style.cssText = `
                position: fixed;
                top: 80px;
                right: 20px;
                width: 350px;
                max-height: 2000px;
                background: white;
                border: 2px solid #0066cc;
                border-radius: 8px;
                padding: 15px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                z-index: 10000;
                overflow-y: auto;
                font-family: Arial, sans-serif;
                font-size: 12px;
            `;
            document.body.appendChild(pane);
        }

        // Sort case numbers in ascending order
        const sortedCaseNumbers = Object.keys(allCaseData).sort();

        let html = '<h3 style="margin: 0 0 15px 0; color: #0066cc;">USCIS Case Status</h3>';

        sortedCaseNumbers.forEach(caseNum => {
            const caseData = allCaseData[caseNum];
            html += `
                <div style="padding: 12px; margin: 10px 0; background: #f0f8ff; border-left: 4px solid #0066cc; border-radius: 4px;">
                    <strong style="color: #0066cc;">${caseNum} - ${caseData.formType}</strong><br>
                    <small style="color: #333;"><strong>Form:</strong>${caseData.formName}</small><br>
                    <small style="color: #333;"><strong>Last Updated:</strong> ${formatDate(caseData.updatedAtTimestamp)}</small><br>
                    <small style="color: #333;"><strong>Current Action:</strong> ${caseData.currentActionCode} - ${caseData.currentActionDesc}</small>

                    <details style="margin-top: 8px; cursor: pointer;">
                        <summary style="color: #0066cc; font-weight: bold;">Events History (${caseData.events.length})</summary>
                        <div style="margin-top: 8px; background: white; padding: 8px; border-radius: 3px;">
                            ${caseData.events.map(event => `
                                <div style="margin-bottom: 8px; padding: 6px; background: #e8f4f8; border-radius: 3px;">
                                    <strong style="color: #0066cc;">${event.eventCode} - ${event.eventDesc}</strong><br>
                                    <strong style="color: #666;">${formatDate(event.updatedAtTimestamp)}</strong><br>
                                </div>
                            `).join('')}
                        </div>
                    </details>
                </div>
            `;
        });

        pane.innerHTML = html;
    }

    // Helper function to format dates
    function formatDate(dateString) {
        if (!dateString) return 'Unknown';
        try {
            const date = new Date(dateString);
            return date.toLocaleString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            return dateString;
        }
    }

    // Wait for the CaseCardsApp component to load
    async function waitForCaseCardsComponent(maxAttempts = 30) {
        // Initial 1 second delay
        await sleep(1000);

        for (let i = 0; i < maxAttempts; i++) {
            // Look for divs with id matching pattern: CaseCardsApp-react-component-*
            const caseCardDivs = document.querySelectorAll('[id^="CaseCardsApp-react-component-"]');

            if (caseCardDivs.length > 0) {
                console.log('CaseCardsApp component found');
                return caseCardDivs[0]; // Return the first matching div
            }

            console.log(`Waiting for CaseCardsApp component... attempt ${i + 1}/${maxAttempts}`);
            await sleep(500); // Check every 500ms
        }

        console.warn('CaseCardsApp component not found after 15 seconds');
        return null;
    }

    // Main function
    async function trackCases() {
        // Wait for the CaseCardsApp component to load
        const caseCardsComponent = await waitForCaseCardsComponent();

        if (!caseCardsComponent) {
            console.warn('Could not load case cards component, attempting to extract case numbers anyway');
        }

        const caseNumbers = extractCaseNumbersFromDOM();
        const stored = getStoredData();

        const newData = {};
        for (const caseNum of caseNumbers) {
            const caseData = await fetchCaseData(caseNum);
            if (caseData) {
                newData[caseNum] = caseData;
            }
        }

        // Detect changes
        const changes = detectChanges(stored.cases, newData);

        // Always display the pane with current data
        createNotificationPane(newData);

        // If there are changes, log them
        if (changes.length > 0) {
            console.log('USCIS Case Changes Detected:', changes);
        }

        // Save to localStorage
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            cases: newData,
            lastFetch: new Date().toISOString()
        }));
    }

    // Run when page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', trackCases);
    } else {
        trackCases();
    }
})();