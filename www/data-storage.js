/**
 * TraderSynth Storage Utility
 * Wraps IndexedDB to provide a larger storage quota than localStorage for forensic reports.
 */

window.reportStorage = (function () {
    const DB_NAME = 'TraderSynthDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'reports';
    const KEY_NAME = 'lastReport';

    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };

            request.onsuccess = (event) => {
                resolve(event.target.result);
            };

            request.onerror = (event) => {
                reject('IndexedDB error: ' + event.target.errorCode);
            };
        });
    }

    return {
        /**
         * Saves report data to IndexedDB.
         * @param {string} data JSON string of the report.
         * @returns {Promise<void>}
         */
        saveReport: async function (data) {
            try {
                const db = await openDB();
                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readwrite');
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.put(data, KEY_NAME);

                    request.onsuccess = () => resolve();
                    request.onerror = () => reject('Failed to save report to IndexedDB');
                });
            } catch (err) {
                console.error(err);
                // Fallback to localStorage if IndexedDB fails (though it might still hit quota)
                try {
                    localStorage.setItem('lastReportData', data);
                } catch (e) { }
                throw err;
            }
        },

        /**
         * Loads report data from IndexedDB.
         * @returns {Promise<string|null>} JSON string of the report or null if not found.
         */
        loadReport: async function () {
            try {
                const db = await openDB();
                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.get(KEY_NAME);

                    request.onsuccess = () => {
                        if (request.result) {
                            resolve(request.result);
                        } else {
                            // Fallback to localStorage if not in IndexedDB
                            resolve(localStorage.getItem('lastReportData'));
                        }
                    };
                    request.onerror = () => reject('Failed to load report from IndexedDB');
                });
            } catch (err) {
                console.error(err);
                return localStorage.getItem('lastReportData');
            }
        },

        /**
         * Clears the report data from both IndexedDB and localStorage.
         * @returns {Promise<void>}
         */
        clearReport: async function () {
            try {
                localStorage.removeItem('lastReportData');
                const db = await openDB();
                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readwrite');
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.delete(KEY_NAME);

                    request.onsuccess = () => resolve();
                    request.onerror = () => reject('Failed to clear report from IndexedDB');
                });
            } catch (err) {
                console.error(err);
            }
        }
    };
})();
