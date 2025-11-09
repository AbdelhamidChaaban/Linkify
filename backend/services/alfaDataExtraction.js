/**
 * Extract consumption data from HTML circles
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<Array>} Array of consumption data
 */
async function extractConsumptionCircles(page) {
    const consumptionData = await page.evaluate(() => {
        const consumptions = [];
        const consumptionElements = document.querySelectorAll('#consumptions .circle');
        
        consumptionElements.forEach((circle) => {
            const circleData = {};
            
            // Extract percentage and data usage
            const span = circle.querySelector('.c100 span');
            if (span) {
                const text = span.textContent.trim();
                const parts = text.split('/');
                if (parts.length === 2) {
                    circleData.used = parts[0].replace(/[^\d.]/g, '').trim();
                    const totalPart = parts[1].trim();
                    circleData.total = totalPart.replace(/[^\d.]/g, '').trim() + 
                                    (totalPart.includes('GB') ? ' GB' : ' MB');
                    circleData.usage = `${circleData.used} / ${circleData.total}`;
                }
            }
            
            // Extract percentage from class (e.g., "p18" = 18%)
            const c100Element = circle.querySelector('.c100');
            if (c100Element) {
                const classList = Array.from(c100Element.classList);
                const pClass = classList.find(c => c.startsWith('p'));
                if (pClass) {
                    circleData.percentage = parseInt(pClass.substring(1));
                }
            }
            
            // Extract plan name and phone number
            const titleElement = circle.querySelector('.title');
            if (titleElement) {
                const titleText = titleElement.textContent.trim();
                const lines = titleText.split('\n').map(l => l.trim()).filter(l => l);
                if (lines.length > 0) {
                    circleData.planName = lines[0];
                }
                if (lines.length > 1) {
                    const secondLine = lines[1];
                    if (secondLine.match(/^\d{8,}$/)) {
                        circleData.phoneNumber = secondLine;
                    }
                }
                // Also check for phone number in light spans
                const lightSpans = titleElement.querySelectorAll('.light');
                lightSpans.forEach(span => {
                    const text = span.textContent.trim();
                    if (text.match(/^\d{8,}$/)) {
                        circleData.phoneNumber = text;
                    }
                });
            }
            
            if (circleData.planName || circleData.usage) {
                consumptions.push(circleData);
            }
        });
        
        return consumptions;
    });
    
    console.log(`📊 Found ${consumptionData.length} consumption circles`);
    return consumptionData;
}

/**
 * Extract balance from HTML
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<string|null>} Balance value or null
 */
async function extractBalanceFromHtml(page) {
    try {
        await page.waitForSelector('#consumption-container', { timeout: 20000 });
        await page.waitForSelector('#consumption-container h2.white', { timeout: 15000 });
        
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const extractedBalance = await page.evaluate(() => {
            const container = document.querySelector('#consumption-container');
            if (container) {
                const textCenter = container.querySelector('.text-center');
                if (textCenter) {
                    const whiteHeading = textCenter.querySelector('h2.white');
                    if (whiteHeading) {
                        const text = whiteHeading.textContent?.trim() || '';
                        const match = text.match(/(\$?\s*-?\d+[,.]?\d*)/i);
                        return match ? match[0].trim() : text.trim();
                    }
                }
                // Fallback: direct h2.white
                const directH2 = container.querySelector('h2.white');
                if (directH2) {
                    const text = directH2.textContent?.trim() || '';
                    const match = text.match(/(\$?\s*-?\d+[,.]?\d*)/i);
                    return match ? match[0].trim() : text.trim();
                }
                // Fallback: container text
                const containerText = container.textContent || '';
                const match = containerText.match(/Current\s+Balance[\s\S]{0,50}(\$?\s*-?\d+[,.]?\d*)/i);
                return match && match[1] ? match[1].trim() : null;
            }
            return null;
        });
        
        if (extractedBalance) {
            return extractedBalance;
        }
    } catch (e) {
        console.log('⚠️ Error extracting balance from HTML:', e.message);
    }
    
    return null;
}

/**
 * Extract total consumption from HTML (U-Share Total Bundle)
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<string|null>} Total consumption string or null
 */
async function extractTotalConsumptionFromHtml(page) {
    try {
        const totalConsumption = await page.evaluate(() => {
            // Look for "U-Share Total Bundle" circle
            const circles = document.querySelectorAll('#consumptions .circle');
            for (const circle of circles) {
                const titleElement = circle.querySelector('.title');
                if (titleElement) {
                    const titleText = titleElement.textContent.trim();
                    if (titleText.includes('Total Bundle') || titleText.includes('U-Share Total')) {
                        const span = circle.querySelector('.c100 span');
                        if (span) {
                            const text = span.textContent.trim();
                            // Extract "47.97 / 77 GB" format
                            const match = text.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
                            if (match) {
                                return `${match[1]} / ${match[2]} ${match[3]}`;
                            }
                        }
                    }
                }
            }
            return null;
        });
        
        if (totalConsumption) {
            return totalConsumption;
        }
    } catch (e) {
        console.log('⚠️ Error extracting total consumption from HTML:', e.message);
    }
    
    return null;
}

module.exports = {
    extractConsumptionCircles,
    extractBalanceFromHtml,
    extractTotalConsumptionFromHtml
};

