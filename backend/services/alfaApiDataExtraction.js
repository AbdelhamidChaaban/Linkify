/**
 * Extract data from getconsumption API response
 * @param {Object} apiResponseData - API response data
 * @returns {Object} Extracted data
 */
function extractFromGetConsumption(apiResponseData) {
    const extracted = {
        balance: null,
        totalConsumption: null,
        secondarySubscribers: [],
        subscribersCount: 0,
        primaryData: apiResponseData // Save full response for later use
    };

    // Extract balance
    const balanceFields = [
        'balance', 'Balance', 'BALANCE',
        'CurrentBalance', 'currentBalance', 'CurrentBalanceValue',
        'Amount', 'amount', 'AMOUNT',
        'BalanceValue', 'balanceValue',
        'CurrentBalanceAmount', 'currentBalanceAmount'
    ];

    for (const field of balanceFields) {
        if (apiResponseData[field] !== undefined && apiResponseData[field] !== null) {
            let balanceValue = apiResponseData[field];
            if (typeof balanceValue === 'number') {
                balanceValue = `$ ${balanceValue.toFixed(2)}`;
            } else {
                balanceValue = String(balanceValue).trim();
                if (/^-?\d+[,.]?\d*$/.test(balanceValue)) {
                    balanceValue = `$ ${balanceValue}`;
                }
            }
            extracted.balance = balanceValue;
            break;
        }
    }

    // Extract consumption data from ServiceInformationValue structure
    if (apiResponseData.ServiceInformationValue && 
        Array.isArray(apiResponseData.ServiceInformationValue) && 
        apiResponseData.ServiceInformationValue.length > 0) {
        
        const firstService = apiResponseData.ServiceInformationValue[0];
        
        if (firstService.ServiceDetailsInformationValue && 
            Array.isArray(firstService.ServiceDetailsInformationValue) && 
            firstService.ServiceDetailsInformationValue.length > 0) {
            
            const firstServiceDetails = firstService.ServiceDetailsInformationValue[0];
            
            // Extract total consumption from SecondaryValue[0]
            if (firstServiceDetails.SecondaryValue && 
                Array.isArray(firstServiceDetails.SecondaryValue) && 
                firstServiceDetails.SecondaryValue.length > 0) {
                
                const firstSecondary = firstServiceDetails.SecondaryValue[0];
                        if (firstSecondary.ConsumptionValue && firstServiceDetails.PackageValue) {
                            extracted.totalConsumption = `${firstSecondary.ConsumptionValue} / ${firstServiceDetails.PackageValue} ${firstServiceDetails.PackageUnitValue || 'GB'}`;
                        }
            }
            
            // Extract secondary subscribers
            if (firstServiceDetails.SecondaryValue && Array.isArray(firstServiceDetails.SecondaryValue)) {
                console.log(`📊 Found ${firstServiceDetails.SecondaryValue.length} SecondaryValue items in getconsumption API`);
                firstServiceDetails.SecondaryValue.forEach((secondary, index) => {
                    const bundleName = secondary.BundleNameValue || '';
                    console.log(`   [${index}] BundleNameValue: "${bundleName}"`);
                    
                    // Check for U-share secondary (case-insensitive, flexible matching)
                    if (bundleName && (
                        bundleName.toLowerCase().includes('u-share secondary') ||
                        bundleName.toLowerCase().includes('ushare secondary') ||
                        bundleName.toLowerCase().includes('secondary')
                    )) {
                        extracted.subscribersCount++;
                        
                        let consumptionValue = secondary.ConsumptionValue || '';
                        let consumptionUnit = secondary.ConsumptionUnitValue || '';
                        let quotaValue = secondary.QuotaValue || '';
                        let quotaUnit = secondary.QuotaUnitValue || '';
                        let secondaryNumber = secondary.SecondaryNumberValue || '';
                        
                        console.log(`   ✅ Found secondary subscriber: ${secondaryNumber}, consumption: ${consumptionValue} ${consumptionUnit}, quota: ${quotaValue} ${quotaUnit}`);
                        
                        // Convert MB to GB if needed
                        let displayConsumption = consumptionValue;
                        if (consumptionUnit === 'MB' && quotaUnit === 'GB') {
                            displayConsumption = (parseFloat(consumptionValue) / 1024).toFixed(2);
                        }
                        
                        extracted.secondarySubscribers.push({
                            phoneNumber: secondaryNumber,
                            consumption: `${displayConsumption} / ${quotaValue} ${quotaUnit}`,
                            rawConsumption: consumptionValue,
                            rawConsumptionUnit: consumptionUnit,
                            quota: quotaValue,
                            quotaUnit: quotaUnit
                        });
                    }
                });
                console.log(`📊 Extracted ${extracted.secondarySubscribers.length} secondary subscribers from getconsumption API`);
            } else {
                console.log('⚠️ No SecondaryValue array found in getconsumption API response');
            }
        }
    }

    return extracted;
}

/**
 * Extract data from getmyservices API response
 * @param {Object} apiResponseData - API response data
 * @returns {Object} Extracted data
 */
function extractFromGetMyServices(apiResponseData) {
    const extracted = {
        adminConsumptionTemplate: null,
        subscriptionDate: null,
        validityDate: null
    };

    // Handle different response structures
    let servicesArray = null;
    
    // Check if response is directly an array
    if (Array.isArray(apiResponseData)) {
        servicesArray = apiResponseData;
    }
    // Check if response has ServiceInformationValue property
    else if (apiResponseData.ServiceInformationValue && Array.isArray(apiResponseData.ServiceInformationValue)) {
        servicesArray = apiResponseData.ServiceInformationValue;
    }
    
    if (!servicesArray || servicesArray.length === 0) {
        return extracted;
    }
    
    // Extract adminConsumptionTemplate from first service (for backward compatibility)
    // Try to find ServiceDetailsInformationValue structure first
    const firstService = servicesArray[0];
    
    if (firstService.ServiceDetailsInformationValue && 
        Array.isArray(firstService.ServiceDetailsInformationValue) && 
        firstService.ServiceDetailsInformationValue.length > 0) {
        
        const firstServiceDetails = firstService.ServiceDetailsInformationValue[0];
        const consumptionValue = firstServiceDetails.ConsumptionValue;
        const consumptionUnit = firstServiceDetails.ConsumptionUnitValue || '';
        
        if (consumptionValue) {
            extracted.adminConsumptionTemplate = {
                serviceName: firstService.ServiceNameValue || 'U-share Main',
                consumptionValue: consumptionValue,
                consumptionUnit: consumptionUnit
            };
        }
    }
    
    // Extract dates from services array
    // Subscription Date = ActivationDate
    // Validity Date = CycleDate
    // PRIORITY: Look for active services with ActiveBundle first, then Mobile Internet, then any service with dates
    let bestService = null;
    let bestServicePriority = 0;
    
    for (const service of servicesArray) {
        let priority = 0;
        
        // Priority 3: Service has ActiveBundle (active subscription)
        if (service.ActiveBundle && service.ActiveBundle !== null) {
            priority = 3;
        }
        // Priority 2: Service is "Mobile Internet" (most relevant service)
        else if (service.Name && (
            service.Name.toLowerCase().includes('mobile internet') ||
            service.Name.toLowerCase().includes('mobile-internet') ||
            service.Alias === 'MCRBWG'
        )) {
            priority = 2;
        }
        // Priority 1: Service has dates (any service with dates)
        else if ((service.ActivationDate && service.ActivationDate !== null) ||
                 (service.CycleDate && service.CycleDate !== null)) {
            priority = 1;
        }
        
        // Update best service if this one has higher priority
        if (priority > bestServicePriority) {
            bestService = service;
            bestServicePriority = priority;
        }
    }
    
    // Extract dates from the best service found
    if (bestService) {
        console.log(`📅 Extracting dates from service: "${bestService.Name || 'Unknown'}" (priority: ${bestServicePriority})`);
        
        // Get ActivationDate for subscription date
        if (bestService.ActivationDate && bestService.ActivationDate !== null) {
            extracted.subscriptionDate = formatDate(bestService.ActivationDate);
            console.log(`   ✅ Subscription Date (ActivationDate): ${extracted.subscriptionDate}`);
        } else {
            console.log(`   ⚠️ No ActivationDate found in service "${bestService.Name || 'Unknown'}"`);
        }
        
        // Get CycleDate for validity date
        if (bestService.CycleDate && bestService.CycleDate !== null) {
            extracted.validityDate = formatDate(bestService.CycleDate);
            console.log(`   ✅ Validity Date (CycleDate): ${extracted.validityDate}`);
        } else {
            console.log(`   ⚠️ No CycleDate found in service "${bestService.Name || 'Unknown'}"`);
        }
    } else {
        console.log('⚠️ No suitable service found with dates in getmyservices response');
        // Fallback: try to get dates from any service (original logic)
        for (const service of servicesArray) {
            // Get ActivationDate for subscription date (skip null values)
            if (service.ActivationDate && service.ActivationDate !== null && !extracted.subscriptionDate) {
                extracted.subscriptionDate = formatDate(service.ActivationDate);
                console.log(`   ✅ Fallback: Subscription Date from "${service.Name || 'Unknown'}": ${extracted.subscriptionDate}`);
            }
            // Get CycleDate for validity date (skip null values)
            if (service.CycleDate && service.CycleDate !== null && !extracted.validityDate) {
                extracted.validityDate = formatDate(service.CycleDate);
                console.log(`   ✅ Fallback: Validity Date from "${service.Name || 'Unknown'}": ${extracted.validityDate}`);
            }
            // If we found both, we can break early
            if (extracted.subscriptionDate && extracted.validityDate) {
                break;
            }
        }
    }

    return extracted;
}

/**
 * Extract expiration from getexpirydate API response
 * @param {any} apiResponseData - API response data (usually just a number)
 * @returns {number} Number of days remaining
 */
function extractExpiration(apiResponseData) {
    if (apiResponseData !== null && apiResponseData !== undefined && apiResponseData !== '') {
                const expiryDays = typeof apiResponseData === 'number' ? apiResponseData : parseInt(apiResponseData);
                if (!isNaN(expiryDays)) {
                    return expiryDays;
                }
    }
    return null;
}

/**
 * Format date as DD/MM/YYYY
 * @param {string} dateString - Date string
 * @returns {string|null} Formatted date or null
 */
function formatDate(dateString) {
    if (!dateString) return null;
    try {
        const date = new Date(dateString);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}/${month}/${year}`;
    } catch (e) {
        return null;
    }
}

/**
 * Build admin consumption from template and HTML data
 * @param {Object} adminConsumptionTemplate - Template from getmyservices
 * @param {Array} consumptions - Consumption circles from HTML
 * @returns {string|null} Admin consumption string or null
 */
function buildAdminConsumption(adminConsumptionTemplate, consumptions) {
    if (!adminConsumptionTemplate || !consumptions || consumptions.length === 0) {
        return null;
    }

    const primaryConsumption = consumptions[0];
    if (!primaryConsumption.used) {
        return null;
    }

    let consumptionValue = adminConsumptionTemplate.consumptionValue;
    let consumptionUnit = adminConsumptionTemplate.consumptionUnit;

    // Convert MB to GB if needed
    if (consumptionUnit === 'MB' && parseFloat(consumptionValue) > 1000) {
        const valueInGB = (parseFloat(consumptionValue) / 1024).toFixed(2);
        consumptionValue = valueInGB;
        consumptionUnit = 'GB';
    }

    const adminConsumption = `${primaryConsumption.used} / ${consumptionValue} ${consumptionUnit}`;
    return adminConsumption;
}

module.exports = {
    extractFromGetConsumption,
    extractFromGetMyServices,
    extractExpiration,
    buildAdminConsumption
};

