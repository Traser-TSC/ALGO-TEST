import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import axios, { AxiosResponse } from 'axios';

/**
 * Node that needs translation
 */
interface TranslationNode {
    id: string;
    sourceText: string;
    targetText?: string;
    state?: string;
    attributes?: any;
    notes?: any[];
    originalPosition?: number;
}

/**
 * TRADOS Cloud Translation configuration
 */
interface TradosTranslationConfig {
    clientId: string;                // Client ID from TRADOS application
    clientSecret: string;            // Client Secret from TRADOS application
    tenantId: string;                // TRADOS Account ID (X-LC-Tenant header)
    translationEngineId: string;     // Your Translation Engine ID
    regionCode?: string;             // Default to 'eu' for Europe
    minimumMatchValue?: number;      // Minimum TM match percentage (default: 70)
}

/**
 * Target file processing result
 */
interface TargetFileResult {
    filePath: string;
    language: string;
    nodesProcessed: number;
    nodesTranslated: number;
    leverageStats?: {
        exactMatches: number;
        fuzzyMatches: number;
        machineTranslations: number;
        noMatches: number;
    };
    success: boolean;
    error?: string;
}

/**
 * TRADOS Auth0 Token Response
 */
interface TradosTokenResponse {
    access_token: string;
    expires_in: number;
    token_type: string;
}

/**
 * TRADOS Translation Lookup Request
 */
interface TradosTranslationLookupRequest {
    input: {
        content: string;
        contentType: 'text' | 'bcm';
    };
    languageDirection: {
        sourceLanguage: {
            languageCode: string;
        };
        targetLanguage: {
            languageCode: string;
        };
    };
    definition: {
        translationEngineId: string;
    };
    settings?: {
        translationMemory?: {
            minimumMatchValue?: number;
            penalties?: {
                standardPenalties?: {
                    missingFormatting?: number;
                    differentFormatting?: number;
                };
            };
        };
    };
}

/**
 * TRADOS Translation Lookup Response
 */
interface TradosTranslationLookupResponse {
    translations?: Array<{
        translationProposal: string; // BCM JSON string
        resourceType: 'TM' | 'MT' | 'TB';
    }>;
    appliedResourceStatus?: Array<{
        resourceId?: string;
        resourceType: 'TM' | 'MT' | 'TB';
        status: 'successful' | 'unsuccessful';
    }>;
}

/**
 * TRADOS Cloud Translation Processor
 * Uses Translation Lookup API to leverage existing Translation Memories
 */
export class TradosTranslationProcessor {
    private parser: xml2js.Parser;
    private builder: xml2js.Builder;
    private config: TradosTranslationConfig;
    private isDryRun: boolean;
    private accessToken?: string;
    private tokenExpiry?: Date;
    private readonly AUTH0_ENDPOINT = 'https://sdl-prod.eu.auth0.com/oauth/token';
    private readonly API_AUDIENCE = 'https://api.sdl.com';
    private rateLimitRemaining: number = 200;
    private rateLimitReset?: Date;

    constructor(config: TradosTranslationConfig) {
        this.config = {
            regionCode: 'eu',
            minimumMatchValue: 70,
            ...config
        };

        this.parser = new xml2js.Parser({
            explicitArray: true,
            mergeAttrs: false,
            explicitRoot: true,
            preserveChildrenOrder: false,
            explicitChildren: false
        });

        this.builder = new xml2js.Builder({
            xmldec: { version: '1.0', encoding: 'utf-8' },
            renderOpts: { pretty: true, indent: '  ' },
            headless: false,
            cdata: false
        });
    }

    /**
     * Enable dry run mode for testing
     */
    enableDryRun(): void {
        console.log('🔄 DRY RUN MODE ENABLED - No TRADOS API calls will be made');
        this.isDryRun = true;
    }

    /**
     * Get the TRADOS API base URL for the configured region
     */
    private getApiBaseUrl(): string {
        return `https://api.${this.config.regionCode}.cloud.trados.com/public-api/v1`;
    }

    /**
     * Authenticate with TRADOS Cloud API using OAuth2 Client Credentials flow
     */
    private async authenticate(): Promise<void> {
        // Check if we have a valid token that's not about to expire (5 min buffer)
        if (this.accessToken && this.tokenExpiry && this.tokenExpiry > new Date(Date.now() + 5 * 60 * 1000)) {
            return;
        }

        try {
                // Authenticating with TRADOS Cloud API
            const authPayload = {
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
                grant_type: 'client_credentials',
                audience: this.API_AUDIENCE
            };

            const authResponse = await axios.post<TradosTokenResponse>(this.AUTH0_ENDPOINT, authPayload, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            this.accessToken = authResponse.data.access_token;
            // Set expiry time with 5 minute buffer to avoid clock drift
            this.tokenExpiry = new Date(Date.now() + (authResponse.data.expires_in - 300) * 1000);
        } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : 'unknown';
            throw new Error(`Failed to authenticate with TRADOS Cloud API (status: ${status})`);
        }
    }

    /**
     * Get authenticated headers for TRADOS API calls
     */
    private async getAuthHeaders(): Promise<Record<string, string>> {
        await this.authenticate();

        return {
            'Authorization': `Bearer ${this.accessToken}`,
            'X-LC-Tenant': this.config.tenantId,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Translate multiple segments concurrently using TRADOS Translation Lookup API
     * Processes segments in batches to avoid overwhelming the API
     */
    private async translateSegmentsBatch(
        nodes: TranslationNode[],
        sourceLanguage: string,
        targetLanguage: string,
        batchSize: number = 3
    ): Promise<Map<string, {
        text: string;
        matchPercent: number;
        originType: 'tm' | 'mt' | 'nmt' | 'tb' | 'none';
        originSystem?: string;
    }>> {
        const results = new Map<string, {
            text: string;
            matchPercent: number;
            originType: 'tm' | 'mt' | 'nmt' | 'tb' | 'none';
            originSystem?: string;
        }>();

        let consecutiveThrottles = 0;
        let batchDelay = 500; // Start with 500ms delay between batches (conservative for 200 req/min limit)

        // Process in batches to avoid overwhelming the API
        for (let i = 0; i < nodes.length; i += batchSize) {
            const batch = nodes.slice(i, i + batchSize);
            const batchPromises = batch.map(node => 
                this.translateSegmentWithRetry(node.sourceText, sourceLanguage, targetLanguage)
                    .then(result => ({ nodeId: node.id, result }))
                    .catch(error => ({
                        nodeId: node.id,
                        result: {
                            text: node.sourceText,
                            matchPercent: 0,
                            originType: 'none' as const,
                            error: true
                        }
                    }))
            );

            const batchResults = await Promise.all(batchPromises);
            
            // Check if any requests actually failed (not just no-match)
            let errorCount = 0;
            for (const { nodeId, result } of batchResults) {
                if ('error' in result && result.error) {
                    errorCount++;
                }
                results.set(nodeId, result);
            }

            // Check if we're approaching rate limit
            if (this.rateLimitRemaining < 20) {
                const now = new Date();
                if (this.rateLimitReset && this.rateLimitReset > now) {
                    const waitMs = this.rateLimitReset.getTime() - now.getTime();
                    console.log(`    ⏳ Rate limit low (${this.rateLimitRemaining} remaining), waiting ${Math.ceil(waitMs / 1000)}s until reset...`);
                    await new Promise(resolve => setTimeout(resolve, waitMs + 100));
                    this.rateLimitRemaining = 200; // Reset after waiting
                }
            }

            // Adaptive delay: increase if we're seeing actual errors
            if (errorCount > 0) {
                consecutiveThrottles++;
                batchDelay = Math.min(batchDelay * 1.5, 5000); // Max 5 second delay
                console.log(`    ⚠️ Detected ${errorCount} failed requests, increasing delay to ${batchDelay}ms`);
            } else if (consecutiveThrottles > 0) {
                consecutiveThrottles = Math.max(0, consecutiveThrottles - 1);
                batchDelay = Math.max(500, batchDelay * 0.9); // Gradually reduce delay
            }

            // Delay between batches to respect rate limits
            if (i + batchSize < nodes.length) {
                await new Promise(resolve => setTimeout(resolve, batchDelay));
            }
        }

        return results;
    }

    /**
     * Translate a segment with retry logic for transient failures
     */
    private async translateSegmentWithRetry(
        sourceText: string,
        sourceLanguage: string,
        targetLanguage: string,
        maxRetries: number = 3
    ): Promise<{
        text: string;
        matchPercent: number;
        originType: 'tm' | 'mt' | 'nmt' | 'tb' | 'none';
        originSystem?: string;
    }> {
        let lastError: any;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.translateSegment(sourceText, sourceLanguage, targetLanguage);
            } catch (error) {
                lastError = error;
                
                // Only retry on network errors or 429/500/503 status codes
                if (axios.isAxiosError(error)) {
                    const status = error.response?.status;
                    const shouldRetry = !status || status === 429 || status >= 500;
                    
                    if (shouldRetry && attempt < maxRetries) {
                        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                }
                
                break;
            }
        }
        
        // All retries failed, throw error to be caught by batch processor
        console.error(`    ⚠️ Failed to translate after ${maxRetries} attempts: "${sourceText.substring(0, 50)}..."`);        
        throw new Error(`Translation failed after ${maxRetries} attempts`);
    }

    /**
     * Translate a single text segment using TRADOS Translation Lookup API
     */
    private async translateSegment(
        sourceText: string,
        sourceLanguage: string,
        targetLanguage: string
    ): Promise<{
        text: string;
        matchPercent: number;
        originType: 'tm' | 'mt' | 'nmt' | 'tb' | 'none';
        originSystem?: string;
    }> {
        // Validate source text - skip truly empty strings (but allow whitespace-only strings)
        if (!sourceText || sourceText === '') {
            return {
                text: sourceText, // Return as-is
                matchPercent: 0,
                originType: 'none'
            };
        }

        if (this.isDryRun) {
            return {
                text: `[DRY RUN] ${sourceText}`,
                matchPercent: 85,
                originType: 'tm',
                originSystem: 'Mock TM'
            };
        }

        try {
            const headers = await this.getAuthHeaders();
            const apiUrl = `${this.getApiBaseUrl()}/translations/lookup`;

            const requestBody: TradosTranslationLookupRequest = {
                input: {
                    content: sourceText,
                    contentType: 'text'
                },
                languageDirection: {
                    sourceLanguage: {
                        languageCode: sourceLanguage
                    },
                    targetLanguage: {
                        languageCode: targetLanguage
                    }
                },
                definition: {
                    translationEngineId: this.config.translationEngineId
                },
                settings: {
                    translationMemory: {
                        minimumMatchValue: this.config.minimumMatchValue,
                        penalties: {
                            standardPenalties: {
                                missingFormatting: 1,
                                differentFormatting: 1
                            }
                        }
                    }
                }
            };

            // Minimal logging - only log segment being translated
            // console.log(`    🔍 Looking up: "${sourceText}"`);

            const response = await axios.post<TradosTranslationLookupResponse>(
                apiUrl,
                requestBody,
                { headers }
            );

            // Track rate limit from response headers
            const rateLimitRemaining = response.headers['x-ratelimit-remaining'];
            const rateLimitReset = response.headers['x-ratelimit-reset'];
            
            if (rateLimitRemaining !== undefined) {
                this.rateLimitRemaining = parseInt(rateLimitRemaining, 10);
            }
            if (rateLimitReset) {
                this.rateLimitReset = new Date(rateLimitReset);
            }

            const result = response.data;

            if (result.translations && result.translations.length > 0) {
                // Find the best translation (prioritize TM over MT)
                let bestTranslation = null;
                let bestMatchPercent = 0;
                let bestOriginType = 'none';
                let bestOriginSystem = '';
                let bestTargetText = '';

                for (const translation of result.translations) {
                    try {
                        // Parse the BCM JSON string
                        const bcmData = JSON.parse(translation.translationProposal);
                        
                        // Extract the target text from BCM structure
                        const targetText = this.extractTextFromBCM(bcmData.targetContent);
                        
                        // Skip if no valid text extracted
                        if (!targetText || targetText.trim() === '') {
                            continue;
                        }
                        
                        const matchPercent = bcmData.targetContent?.translationOrigin?.matchPercent || 0;
                        const originType = bcmData.targetContent?.translationOrigin?.originType || translation.resourceType.toLowerCase();
                        const originSystem = bcmData.targetContent?.translationOrigin?.originSystem || '';

                        // Prioritize TM matches over MT, and higher match percentages
                        const isBetter = !bestTranslation || 
                                       (translation.resourceType === 'TM' && bestOriginType !== 'tm') ||
                                       (translation.resourceType === bestTranslation.resourceType && matchPercent > bestMatchPercent);

                        if (isBetter) {
                            bestTranslation = translation;
                            bestMatchPercent = matchPercent;
                            bestOriginType = originType;
                            bestOriginSystem = originSystem;
                            bestTargetText = targetText;
                        }
                    } catch (error) {
                        // Log BCM parsing failures for debugging
                        if (this.isDryRun) {
                            console.error(`Failed to parse translation response:`, error);
                        }
                        continue;
                    }
                }

                if (bestTranslation && bestTargetText) {
                    return {
                        text: bestTargetText,
                        matchPercent: bestMatchPercent,
                        originType: bestOriginType as 'tm' | 'mt' | 'nmt' | 'tb' | 'none',
                        originSystem: bestOriginSystem
                    };
                }
            }

            // No translation found - API returned empty or all translations failed to parse
            return {
                text: sourceText, // Return original text if no translation
                matchPercent: 0,
                originType: 'none'
            };

        } catch (error) {
            // Return original text on error (logged in retry logic if all attempts fail)
            return {
                text: sourceText,
                matchPercent: 0,
                originType: 'none'
            };
        }
    }

    /**
     * Extract text content from BCM (Bilingual Content Model) structure
     */
    private extractTextFromBCM(bcmContent: any): string {
        if (!bcmContent || !bcmContent.children) {
            return '';
        }

        // BCM content has a children array with text nodes
        const textParts: string[] = [];
        for (const child of bcmContent.children) {
            if (child.type === 'text' && child.text) {
                textParts.push(child.text);
            }
        }

        return textParts.join('');
    }

    /**
     * Determine XLIFF state - always needs review regardless of match quality
     */
    private determineXliffState(matchPercent: number, originType: string): string {
        // All TRADOS translations should be reviewed, regardless of match percentage
        return 'needs-review-translation';
    }

    /**
     * Process global XLIFF with multiple target files using TRADOS Translation Lookup API
     */
    async processGlobalXliffWithTargets(
        globalXliffPath: string,
        targetFilePaths: string[],
        outputPath: string,
        maxConcurrentFiles: number = 1
    ): Promise<{
        totalFiles: number;
        successfulFiles: number;
        totalNodesTranslated: number;
        results: TargetFileResult[];
    }> {
        console.log(`Processing ${targetFilePaths.length} target file(s) with TRADOS Translation Engine (${maxConcurrentFiles} concurrent)`);

        // Parse global XLIFF
        const globalXliff = await this.parseXliffFile(globalXliffPath);
        const globalNodes = this.extractNodesFromXliff(globalXliff);

        const results: TargetFileResult[] = [];
        let totalNodesTranslated = 0;

        // Process files in parallel batches to improve performance
        for (let i = 0; i < targetFilePaths.length; i += maxConcurrentFiles) {
            const batch = targetFilePaths.slice(i, i + maxConcurrentFiles);
            
            const batchPromises = batch.map(async (targetFilePath) => {
                try {
                    return await this.processTargetFile(
                        globalNodes,
                        targetFilePath,
                        outputPath
                    );
                } catch (error) {
                    console.error(`❌ Failed to process ${targetFilePath}:`, error);
                    return {
                        filePath: targetFilePath,
                        language: 'unknown',
                        nodesProcessed: 0,
                        nodesTranslated: 0,
                        success: false,
                        error: error instanceof Error ? error.message : 'Unknown error'
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
            
            for (const result of batchResults) {
                if (result.success) {
                    totalNodesTranslated += result.nodesTranslated;
                }
            }
        }

        const successfulFiles = results.filter(r => r.success).length;

        return {
            totalFiles: targetFilePaths.length,
            successfulFiles,
            totalNodesTranslated,
            results
        };
    }

    /**
     * Process a single target file
     */
    private async processTargetFile(
        globalNodes: TranslationNode[],
        targetFilePath: string,
        outputPath: string
    ): Promise<TargetFileResult> {
        const targetLanguage = this.extractLanguageFromFilename(targetFilePath);
        console.log(`Processing: ${path.basename(targetFilePath)} (${targetLanguage})`);

        // Parse existing target file or create new structure
        let targetXliff: any;
        let existingNodes: TranslationNode[] = [];

        if (fs.existsSync(targetFilePath)) {
            targetXliff = await this.parseXliffFile(targetFilePath);
            existingNodes = this.extractNodesFromXliff(targetXliff);
        } else {
            targetXliff = this.createNewTargetXliff(targetLanguage);
        }

        // Identify nodes that need translation
        const nodesToTranslate = this.identifyNodesToTranslate(globalNodes, existingNodes);
        if (nodesToTranslate.length > 0) {
            console.log(`  Translating ${nodesToTranslate.length} segment(s)...`);
        }

        let translations = new Map<string, {
            text: string;
            matchPercent: number;
            originType: string;
            originSystem?: string;
        }>();

        let leverageStats = {
            exactMatches: 0,
            fuzzyMatches: 0,
            machineTranslations: 0,
            noMatches: 0
        };

        if (nodesToTranslate.length > 0) {
            const sourceLanguage = 'en-US';
            
            // Use batch translation with concurrency (3 concurrent requests per batch)
            translations = await this.translateSegmentsBatch(
                nodesToTranslate,
                sourceLanguage,
                targetLanguage,
                3
            );

            // Calculate leverage statistics from results
            for (const result of translations.values()) {
                if (result.matchPercent === 100 && result.originType === 'tm') {
                    leverageStats.exactMatches++;
                } else if (result.matchPercent >= 70 && result.originType === 'tm') {
                    leverageStats.fuzzyMatches++;
                } else if (result.originType === 'mt' || result.originType === 'nmt') {
                    leverageStats.machineTranslations++;
                } else {
                    leverageStats.noMatches++;
                }
            }

            console.log(`  Leverage: ${leverageStats.exactMatches} exact, ${leverageStats.fuzzyMatches} fuzzy, ${leverageStats.machineTranslations} MT, ${leverageStats.noMatches} no match`);
        }

        // Merge translations back into target structure
        const updatedTargetXliff = this.mergeNodesIntoTarget(
            globalNodes,
            targetXliff,
            targetLanguage,
            translations,
            existingNodes
        );

        // Save updated target file
        await this.saveTargetFile(updatedTargetXliff, targetFilePath, outputPath);

        return {
            filePath: targetFilePath,
            language: targetLanguage,
            nodesProcessed: globalNodes.length,
            nodesTranslated: translations.size,
            leverageStats,
            success: true
        };
    }

    // ... (Include all the helper methods from your existing sync-document-translation-processor.ts)
    // parseXliffFile, extractNodesFromXliff, identifyNodesToTranslate, mergeNodesIntoTarget, etc.

    /**
     * Extract language code from filename (e.g., "file.de-DE.xlf" -> "de-DE")
     */
    private extractLanguageFromFilename(filePath: string): string {
        const filename = path.basename(filePath);
        const match = filename.match(/\.([a-z]{2}-[A-Z]{2})\.xlf$/);
        return match ? match[1] : 'unknown';
    }

    /**
     * Parse XLIFF file
     */
    private async parseXliffFile(filePath: string): Promise<any> {
        const content = fs.readFileSync(filePath, 'utf-8');
        return await this.parser.parseStringPromise(content);
    }

    /**
     * Extract translation nodes from XLIFF structure
     */
    private extractNodesFromXliff(xliff: any): TranslationNode[] {
        const nodes: TranslationNode[] = [];

        if (xliff?.xliff?.file) {
            const files = Array.isArray(xliff.xliff.file) ? xliff.xliff.file : [xliff.xliff.file];

            for (const file of files) {
                if (file?.body?.[0]?.group) {
                    const groups = Array.isArray(file.body[0].group) ? file.body[0].group : [file.body[0].group];

                    for (const group of groups) {
                        if (group?.['trans-unit']) {
                            const transUnits = Array.isArray(group['trans-unit']) ? group['trans-unit'] : [group['trans-unit']];

                            for (const unit of transUnits) {
                                if (unit?.$ && unit.source?.[0]) {
                                    const sourceText = typeof unit.source[0] === 'string' ? unit.source[0] : unit.source[0]._ || '';
                                    nodes.push({
                                        id: unit.$.id,
                                        sourceText: sourceText, // Preserve whitespace - xml:space="preserve" is set
                                        targetText: unit.target?.[0]?._ || unit.target?.[0] || '',
                                        state: unit.target?.[0]?.$?.state || 'new',
                                        attributes: unit.$,
                                        notes: unit.note || []
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        return nodes;
    }

    /**
     * Identify nodes that need translation
     */
    private identifyNodesToTranslate(
        globalNodes: TranslationNode[],
        existingNodes: TranslationNode[]
    ): TranslationNode[] {
        const existingNodesMap = new Map(existingNodes.map(node => [node.id, node]));
        const nodesToTranslate: TranslationNode[] = [];

        for (const globalNode of globalNodes) {
            // Skip nodes with truly empty source text (but preserve whitespace-only strings)
            if (!globalNode.sourceText || globalNode.sourceText === '') {
                continue;
            }

            const existingNode = existingNodesMap.get(globalNode.id);

            if (!existingNode) {
                // Node doesn't exist in target - needs translation
                nodesToTranslate.push(globalNode);
            } else if (existingNode.state === 'new' || existingNode.state === 'needs-translation') {
                // Existing node with state="new" or "needs-translation" - needs translation
                nodesToTranslate.push(globalNode);
            }
            // Note: If source changed but translation exists, we DON'T translate
            // We preserve the existing translation and mark for review in mergeNodesIntoTarget
        }

        return nodesToTranslate;
    }

    /**
     * Merge translations into target XLIFF structure
     * Maintains the order of nodes from the global XLIFF
     */
    private mergeNodesIntoTarget(
        globalNodes: TranslationNode[],
        targetXliff: any,
        targetLanguage: string,
        translations: Map<string, { text: string; matchPercent: number; originType: string; originSystem?: string }>,
        existingNodes: TranslationNode[]
    ): any {
        if (!targetXliff?.xliff?.file?.[0]?.body?.[0]?.group?.[0]?.['trans-unit']) {
            targetXliff.xliff.file[0].body[0].group[0]['trans-unit'] = [];
        }

        const existingTransUnits = targetXliff.xliff.file[0].body[0].group[0]['trans-unit'];
        const existingUnitsMap = new Map();
        const existingNodesMap = new Map(existingNodes.map(node => [node.id, node]));

        // Map existing units by ID for quick lookup
        for (const unit of existingTransUnits) {
            if (unit?.$.id) {
                existingUnitsMap.set(unit.$.id, unit);
            }
        }

        // Build new trans-units array in the order of globalNodes
        const newTransUnits = [];

        for (const globalNode of globalNodes) {
            const translation = translations.get(globalNode.id);
            const existingUnit = existingUnitsMap.get(globalNode.id);

            if (existingUnit) {
                // Update existing unit
                const oldSourceText = existingUnit.source[0];
                const sourceChanged = oldSourceText !== globalNode.sourceText;
                
                existingUnit.source[0] = globalNode.sourceText;

                if (translation) {
                    // We have a new translation from TRADOS (node was new, or had state="new"/"needs-translation")
                    existingUnit.target[0]._ = translation.text;
                    existingUnit.target[0].$.state = this.determineXliffState(translation.matchPercent, translation.originType);

                    // Add TRADOS-specific attributes
                    if (translation.matchPercent > 0) {
                        existingUnit.target[0].$['match-percent'] = translation.matchPercent.toString();
                    }
                    if (translation.originType) {
                        existingUnit.target[0].$['origin-type'] = translation.originType;
                    }
                    if (translation.originSystem) {
                        existingUnit.target[0].$['origin-system'] = translation.originSystem;
                    }
                    
                    // Remove state-qualifier since we have a fresh translation
                    if (existingUnit.target[0].$['state-qualifier']) {
                        delete existingUnit.target[0].$['state-qualifier'];
                    }
                } else if (sourceChanged) {
                    // Source changed but no new translation - preserve existing translation and mark for review
                    existingUnit.target[0].$.state = 'needs-review-translation';
                    existingUnit.target[0].$['state-qualifier'] = 'source-changed';
                    
                    // Remove TRADOS attributes since translation is outdated
                    if (existingUnit.target[0].$['match-percent']) {
                        delete existingUnit.target[0].$['match-percent'];
                    }
                    if (existingUnit.target[0].$['origin-type']) {
                        delete existingUnit.target[0].$['origin-type'];
                    }
                    if (existingUnit.target[0].$['origin-system']) {
                        delete existingUnit.target[0].$['origin-system'];
                    }
                } else {
                    // No translation and source didn't change - preserve everything as-is
                    // Don't modify any attributes, keep existing state, state-qualifier, etc.
                }

                // Add the updated existing unit to the new array
                newTransUnits.push(existingUnit);
            } else {
                // Create new unit
                const newUnit = {
                    $: {
                        id: globalNode.id,
                        translate: 'yes',
                        'xml:space': 'preserve'
                    },
                    source: [globalNode.sourceText],
                    target: [{
                        _: translation?.text || '',
                        $: {
                            state: translation ? this.determineXliffState(translation.matchPercent, translation.originType) : 'new'
                        }
                    }],
                    ...(globalNode.notes && { note: globalNode.notes })
                };

                // Add TRADOS-specific attributes for new units
                if (translation && translation.matchPercent > 0) {
                    newUnit.target[0].$['match-percent'] = translation.matchPercent.toString();
                }
                if (translation && translation.originType) {
                    newUnit.target[0].$['origin-type'] = translation.originType;
                }
                if (translation && translation.originSystem) {
                    newUnit.target[0].$['origin-system'] = translation.originSystem;
                }

                // Add the new unit to the array
                newTransUnits.push(newUnit);
            }
        }

        // Replace the trans-units array with the new ordered array
        targetXliff.xliff.file[0].body[0].group[0]['trans-unit'] = newTransUnits;

        return targetXliff;
    }

    /**
     * Create new target XLIFF structure
     */
    private createNewTargetXliff(targetLanguage: string): any {
        return {
            xliff: {
                $: {
                    version: '1.2',
                    xmlns: 'urn:oasis:names:tc:xliff:document:1.2',
                    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
                    'xsi:schemaLocation': 'urn:oasis:names:tc:xliff:document:1.2 xliff-core-1.2-transitional.xsd'
                },
                file: [{
                    $: {
                        datatype: 'xml',
                        'source-language': 'en-US',
                        'target-language': targetLanguage,
                        original: 'trados-translation.xlf'
                    },
                    header: [{
                        tool: [{
                            $: {
                                'tool-id': 'TRADOS-Translation-Lookup',
                                'tool-name': 'TRADOS Translation Lookup Processor',
                                'tool-version': '1.0.0',
                                'tool-company': 'RWS'
                            }
                        }]
                    }],
                    body: [{
                        group: [{
                            $: { id: 'body' },
                            'trans-unit': []
                        }]
                    }]
                }]
            }
        };
    }

    /**
     * Save target file
     */
    private async saveTargetFile(xliff: any, originalPath: string, outputPath: string): Promise<void> {
        const filename = path.basename(originalPath);
        const outputFilePath = path.join(outputPath, filename);

        // Ensure output directory exists
        if (!fs.existsSync(outputPath)) {
            fs.mkdirSync(outputPath, { recursive: true });
        }

        let xmlContent = this.builder.buildObject(xliff);
        
        // Post-process XML to convert self-closing tags to full closing tags
        // This preserves whitespace content and maintains XLIFF standards
        xmlContent = xmlContent.replace(/<(note|target|source)([^>]*)\/>/g, '<$1$2></$1>');
        
        fs.writeFileSync(outputFilePath, xmlContent, 'utf-8');
    }
}
