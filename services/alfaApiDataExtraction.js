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
                firstServiceDetails.SecondaryValue.forEach((secondary) => {
                    if (secondary.BundleNameValue && secondary.BundleNameValue.includes('U-share secondary')) {
                        extracted.subscribersCount++;
                        
                        let consumptionValue = secondary.ConsumptionValue || '';
                        let consumptionUnit = secondary.ConsumptionUnitValue || '';
                        let quotaValue = secondary.QuotaValue || '';
                        let quotaUnit = secondary.QuotaUnitValue || '';
                        let secondaryNumber = secondary.SecondaryNumberValue || '';
                        
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

    if (apiResponseData.ServiceInformationValue && 
        Array.isArray(apiResponseData.ServiceInformationValue) && 
        apiResponseData.ServiceInformationValue.length > 0) {
        
        const firstService = apiResponseData.ServiceInformationValue[0];
        
        if (firstService.ServiceDetailsInformationValue && 
            Array.isArray(firstService.ServiceDetailsInformationValue) && 
            firstService.ServiceDetailsInformationValue.length > 0) {
            
            const firstServiceDetails = firstService.ServiceDetailsInformationValue[0];
            const consumptionValue = firstServiceDetails.ConsumptionValue;
            const consumptionUnit = firstServiceDetails.ConsumptionUnitValue || '';
            
            extracted.adminConsumptionTemplate = {
                serviceName: firstService.ServiceNameValue || 'U-share Main',
                consumptionValue: consumptionValue,
                consumptionUnit: consumptionUnit
            };
        }
        
        // Extract dates
        const serviceWithActivation = apiResponseData.ServiceInformationValue.find(service => service.ActivationDate);
        if (serviceWithActivation && serviceWithActivation.ActivationDate) {
            extracted.subscriptionDate = formatDate(serviceWithActivation.ActivationDate);
        }
        
        const serviceWithCycle = apiResponseData.ServiceInformationValue.find(service => service.CycleDate);
        if (serviceWithCycle && serviceWithCycle.CycleDate) {
            extracted.validityDate = formatDate(serviceWithCycle.CycleDate);
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

