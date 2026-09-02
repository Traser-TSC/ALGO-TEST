import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { TradosTranslationProcessor } from './trados-translation-processor';

function basenameWithoutGXlf(globalXliffFile: string): string {
    // "ALGO-TEST.g.xlf" -> "ALGO-TEST"
    return path.basename(globalXliffFile).replace(/\.g\.xlf$/, '');
}

async function run(): Promise<void> {
    try {
        const dryRun = core.getBooleanInput('dryRun');

        // Only require real TRADOS credentials outside dryRun - translateSegment()
        // returns a mock result before any auth call is made when dryRun is set,
        // so a plumbing-only test run shouldn't need secrets to exist yet.
        const clientId = core.getInput('clientId', { required: !dryRun });
        const clientSecret = core.getInput('clientSecret', { required: !dryRun });
        const tenantId = core.getInput('tenantId', { required: !dryRun });
        const translationEngineId = core.getInput('translationEngineId', { required: !dryRun });
        const regionCode = core.getInput('regionCode') || 'eu';
        const minimumMatchValue = parseInt(core.getInput('minimumMatchValue') || '70', 10);

        const globalXliffFile = core.getInput('globalXliffFile', { required: true });
        const translationsFolder = core.getInput('translationsFolder', { required: true });
        const targetLanguagesInput = core.getInput('targetLanguages', { required: true });

        const targetLanguages = targetLanguagesInput
            .split(',')
            .map(lang => lang.trim())
            .filter(lang => lang.length > 0);

        if (targetLanguages.length === 0) {
            throw new Error('At least one target language must be specified via targetLanguages');
        }

        if (!fs.existsSync(globalXliffFile)) {
            throw new Error(`Global XLIFF file not found: ${globalXliffFile}`);
        }

        const baseName = basenameWithoutGXlf(globalXliffFile);
        core.info(`Global XLIFF: ${globalXliffFile}`);
        core.info(`Target languages: ${targetLanguages.join(', ')}`);

        // Build target file paths from targetLanguages directly, instead of globbing for
        // files that already exist - a language with no .xlf yet still gets a path here,
        // and TradosTranslationProcessor.processTargetFile() creates it via createNewTargetXliff()
        // when the path doesn't exist yet.
        const targetFilePaths = targetLanguages.map(lang =>
            path.join(translationsFolder, `${baseName}.${lang}.xlf`)
        );

        const processor = new TradosTranslationProcessor({
            clientId,
            clientSecret,
            tenantId,
            translationEngineId,
            regionCode,
            minimumMatchValue
        });

        if (dryRun) {
            processor.enableDryRun();
        }

        const result = await processor.processGlobalXliffWithTargets(
            globalXliffFile,
            targetFilePaths,
            translationsFolder
        );

        core.info('');
        core.info('=== Translation Summary ===');
        core.info(`Files processed: ${result.totalFiles}`);
        core.info(`Files succeeded: ${result.successfulFiles}`);
        core.info(`Total nodes translated: ${result.totalNodesTranslated}`);

        await core.summary
            .addHeading('Translation results', 2)
            .addTable([
                [
                    { data: 'Language', header: true },
                    { data: 'Status', header: true },
                    { data: 'Nodes translated', header: true }
                ],
                ...result.results.map(r => [
                    r.language,
                    r.success ? '✅' : `❌ ${r.error ?? 'unknown error'}`,
                    r.nodesTranslated.toString()
                ])
            ])
            .write();

        core.setOutput('processedFiles', result.successfulFiles.toString());
        core.setOutput('translatedNodesCount', result.totalNodesTranslated.toString());

        if (result.successfulFiles === 0) {
            core.setFailed('No target files were successfully processed');
            return;
        }

        if (result.successfulFiles < result.totalFiles) {
            core.warning(`${result.totalFiles - result.successfulFiles} of ${result.totalFiles} target file(s) failed - see the job summary for details`);
        }
    } catch (error) {
        core.setFailed(error instanceof Error ? error.message : 'Unknown error occurred');
    }
}

run();
