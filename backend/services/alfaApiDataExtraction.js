/**
 * Extract data from getconsumption API response
 * @param {Object} apiResponseData - API response data
 * @returns {Object} Extracted data
 */
function extractFromGetConsumption(apiResponseData) {
    const extracted = {
        balance: null,
        totalConsumption: null,
        adminConsumption: null,
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
            
            // Extract admin consumption from first service details
            // CRITICAL: PackageValue is the TOTAL BUNDLE SIZE (e.g., 77 GB), NOT the admin's quota
            // The admin's quota is stored in Firebase (data.quota), not in the API response
            // We need to extract admin consumption WITHOUT using PackageValue as the limit
            // Instead, we'll extract it in a format that the frontend can parse and add the correct limit
            
            // First, check if there's a "U-Share Main" or similar bundle in SecondaryValue that represents admin consumption
            // If not, use firstServiceDetails.ConsumptionValue (which is the admin's consumption)
            let adminConsumptionValue = '';
            let adminConsumptionUnit = '';
            let adminQuotaFromApi = null; // Will be null if not found in API
            
            // Look for admin's individual bundle in SecondaryValue (not the total bundle)
            if (firstServiceDetails.SecondaryValue && Array.isArray(firstServiceDetails.SecondaryValue)) {
                // Find bundles that are NOT "U-Share Total Bundle" - these might be admin's individual consumption
                // But actually, SecondaryValue items are for secondary subscribers, not admin
                // So we should use firstServiceDetails.ConsumptionValue for admin consumption
            }
            
            // CRITICAL: When there's no SecondaryValue array, ConsumptionValue is the TOTAL consumption, not admin consumption
            // For admins with 0 subscribers, admin consumption should be 0
            // We need to check if there are any secondary subscribers to determine admin consumption
            
            // Check if there are any secondary subscribers (not just the total bundle)
            let hasSecondarySubscribers = false;
            if (firstServiceDetails.SecondaryValue && Array.isArray(firstServiceDetails.SecondaryValue)) {
                hasSecondarySubscribers = firstServiceDetails.SecondaryValue.some(secondary => {
                    const bundleName = (secondary.BundleNameValue || '').toLowerCase();
                    // Check if it's a secondary subscriber bundle (not the total bundle)
                    return (bundleName.includes('u-share secondary') || bundleName.includes('secondary')) &&
                           !bundleName.includes('total') && !bundleName.includes('bundle');
                });
            }
            
            if (hasSecondarySubscribers) {
                // If there are secondary subscribers, we can't determine admin consumption from this API alone
                // Admin consumption will be calculated as: total consumption - sum of secondary subscribers
                // For now, set to null/empty - frontend will calculate it from the secondary subscribers
                console.log(`⚠️ Found secondary subscribers, cannot determine admin consumption from ConsumptionValue (it's total consumption)`);
                extracted.adminConsumption = null; // Will be calculated by frontend
            } else {
                // No secondary subscribers - admin consumption should be 0
                // ConsumptionValue is the total consumption, not admin consumption
                // When there are 0 subscribers, the admin hasn't used their share yet
                console.log(`✅ No secondary subscribers found, admin consumption should be 0 (ConsumptionValue ${firstServiceDetails.ConsumptionValue || 'N/A'} is total consumption, not admin consumption)`);
                extracted.adminConsumption = '0 GB';
            }
            
            // Old logic (commented out - was incorrectly using ConsumptionValue as admin consumption)
            // adminConsumptionValue = firstServiceDetails.ConsumptionValue || '';
            // adminConsumptionUnit = firstServiceDetails.ConsumptionUnitValue || '';
            
            if (false) { // Disabled - was using total consumption as admin consumption
                // Fallback: Try to extract from any numeric fields if standard fields are missing
                console.warn('⚠️ Standard admin consumption fields missing, trying fallback extraction...');
                const numericFields = Object.keys(firstServiceDetails).filter(key => {
                    const value = firstServiceDetails[key];
                    return typeof value === 'number' || (typeof value === 'string' && /^[\d.]+$/.test(value.trim()));
                });
                
                if (numericFields.length >= 2) {
                    // Try to use first two numeric fields as consumption/limit
                    const val1 = parseFloat(firstServiceDetails[numericFields[0]]) || 0;
                    const val2 = parseFloat(firstServiceDetails[numericFields[1]]) || 0;
                    if (val1 > 0 && val2 > 0) {
                        // Assume first is consumption, second is limit
                        extracted.adminConsumption = `${val1.toFixed(2)} / ${val2.toFixed(2)} GB`;
                        console.log(`✅ Extracted admin consumption (fallback): ${extracted.adminConsumption}`);
                    }
                }
            }
            
            // Extract total consumption
            // Format: "consumption / quota" (numbers only, no units)
            // QuotaValue is the number after "/"
            if (firstServiceDetails.SecondaryValue && 
                Array.isArray(firstServiceDetails.SecondaryValue) && 
                firstServiceDetails.SecondaryValue.length > 0) {
                
                // Find the "U-Share Total Bundle" item to get QuotaValue (the number after "/")
                const totalBundle = firstServiceDetails.SecondaryValue.find(secondary => {
                    const bundleName = (secondary.BundleNameValue || '').toLowerCase();
                    return bundleName.includes('u-share total') || 
                           bundleName.includes('total bundle') ||
                           bundleName === 'u-share total bundle';
                }) || firstServiceDetails.SecondaryValue[0]; // Fallback to first item if not found
                
                if (totalBundle) {
                    // QuotaValue is the number after "/" in total consumption
                    const quotaValue = totalBundle.QuotaValue || '';
                    
                    // Consumption value can come from either:
                    // 1. Total Bundle's ConsumptionValue (preferred)
                    // 2. Parent level ConsumptionValue (fallback)
                    let consumptionValue = totalBundle.ConsumptionValue || firstServiceDetails.ConsumptionValue || '';
                    let consumptionUnit = totalBundle.ConsumptionUnitValue || firstServiceDetails.ConsumptionUnitValue || '';
                    const quotaUnit = totalBundle.QuotaUnitValue || '';
                    
                    if (consumptionValue && quotaValue) {
                        // Convert MB to GB if needed for consistent display (quota is usually in GB)
                        let displayConsumption = parseFloat(consumptionValue);
                        if (consumptionUnit === 'MB' && quotaUnit === 'GB') {
                            displayConsumption = displayConsumption / 1024;
                        }
                        
                        // Format: "X / Y" (numbers only, no units - frontend will add "GB")
                        extracted.totalConsumption = `${displayConsumption.toFixed(2)} / ${quotaValue}`;
                        console.log(`✅ Extracted total consumption: ${extracted.totalConsumption} (QuotaValue: ${quotaValue} is after "/")`);
                    } else {
                        // Fallback: Try to extract from totalBundle directly
                        console.warn('⚠️ Standard total consumption fields missing, trying fallback extraction...');
                        const numericFields = Object.keys(totalBundle).filter(key => {
                            const value = totalBundle[key];
                            return typeof value === 'number' || (typeof value === 'string' && /^[\d.]+$/.test(value.trim()));
                        });
                        
                        if (numericFields.length >= 2) {
                            const val1 = parseFloat(totalBundle[numericFields[0]]) || 0;
                            const val2 = parseFloat(totalBundle[numericFields[1]]) || 0;
                            if (val1 > 0 && val2 > 0) {
                                extracted.totalConsumption = `${val1.toFixed(2)} / ${val2.toFixed(2)}`;
                                console.log(`✅ Extracted total consumption (fallback): ${extracted.totalConsumption}`);
                            }
                        }
                    }
                } else {
                    // Fallback: Try to extract from firstServiceDetails if SecondaryValue structure is missing
                    console.warn('⚠️ SecondaryValue structure missing, trying direct extraction from firstServiceDetails...');
                    const directQuota = firstServiceDetails.QuotaValue || '';
                    const directConsumption = firstServiceDetails.ConsumptionValue || '';
                    if (directConsumption && directQuota) {
                        let displayConsumption = parseFloat(directConsumption);
                        const consumptionUnit = firstServiceDetails.ConsumptionUnitValue || '';
                        if (consumptionUnit === 'MB') {
                            displayConsumption = displayConsumption / 1024;
                        }
                        extracted.totalConsumption = `${displayConsumption.toFixed(2)} / ${directQuota}`;
                        console.log(`✅ Extracted total consumption (direct fallback): ${extracted.totalConsumption}`);
                    }
                }
            } else {
                // SecondaryValue array doesn't exist - try to extract from firstServiceDetails directly
                // Use PackageValue as the quota (total bundle size) and ConsumptionValue as consumption
                console.warn('⚠️ No SecondaryValue array found in getconsumption API response, trying direct extraction from firstServiceDetails...');
                const directConsumption = firstServiceDetails.ConsumptionValue || '';
                const directQuota = firstServiceDetails.PackageValue || firstServiceDetails.QuotaValue || '';
                const consumptionUnit = firstServiceDetails.ConsumptionUnitValue || '';
                const quotaUnit = firstServiceDetails.PackageUnitValue || firstServiceDetails.QuotaUnitValue || '';
                
                if (directConsumption && directQuota) {
                    let displayConsumption = parseFloat(directConsumption);
                    if (consumptionUnit === 'MB' && (quotaUnit === 'GB' || !quotaUnit)) {
                        displayConsumption = displayConsumption / 1024;
                    }
                    extracted.totalConsumption = `${displayConsumption.toFixed(2)} / ${directQuota}`;
                    console.log(`✅ Extracted total consumption (no SecondaryValue fallback): ${extracted.totalConsumption} (using PackageValue/QuotaValue: ${directQuota} ${quotaUnit || 'GB'})`);
                } else {
                    console.warn(`⚠️ Cannot extract total consumption - missing ConsumptionValue (${directConsumption}) or PackageValue/QuotaValue (${directQuota})`);
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
        // Return null if NaN, 0, or negative (invalid expiration)
        if (!isNaN(expiryDays) && expiryDays > 0) {
            return expiryDays;
        }
    }
    return null;
}

/**
 * Format date as DD/MM/YYYY
 * @param {string} dateString - Date string
 * @returns {string|null} Formatted date or null (never returns NaN/NaN/NaN)
 */
function formatDate(dateString) {
    if (!dateString) return null;
    try {
        const date = new Date(dateString);
        // CRITICAL: Validate date is valid (not Invalid Date)
        if (isNaN(date.getTime())) {
            console.warn(`⚠️ Invalid date string: ${dateString}`);
            return null;
        }
        const day = date.getDate();
        const month = date.getMonth() + 1;
        const year = date.getFullYear();
        
        // CRITICAL: Check for NaN values before formatting
        if (isNaN(day) || isNaN(month) || isNaN(year)) {
            console.warn(`⚠️ Date components are NaN for: ${dateString}`);
            return null;
        }
        
        const formattedDay = String(day).padStart(2, '0');
        const formattedMonth = String(month).padStart(2, '0');
        const formattedYear = String(year);
        
        return `${formattedDay}/${formattedMonth}/${formattedYear}`;
    } catch (e) {
        console.warn(`⚠️ Error formatting date: ${dateString}`, e.message);
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

