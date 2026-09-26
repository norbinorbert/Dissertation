chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchImage') {
        fetch(request.url)
            .then((response) => response.blob())
            .then((blob) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    sendResponse({ dataUrl: reader.result });
                };
                reader.readAsDataURL(blob);
            })
            .catch((err) => sendResponse({ error: err.toString() }));

        // Return true to indicate we will respond asynchronously
        return true; 
    }
});