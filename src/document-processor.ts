/**
 * Document Processor Module
 *
 * Orchestrates the full entity extraction and linking workflow:
 * 1. Read target document
 * 2. Build/load vault entity index
 * 3. Extract entities via LLM
 * 4. Resolve against existing entities
 * 5. Generate output (wikilinks, frontmatter, new entity files)
 */

import {
  ExtractedEntity,
  SuggestedWikilink,
  ExtractionResult,
  VaultEntity,
  buildExtractionPrompt,
  parseExtractionResponse,
  findMentionOffsets,
  generateSuggestedFrontmatter,
  generateSuggestedWikilinks
} from './entity-extraction.js';

import {
  EntityResolver,
  ResolutionResult,
  createResolver
} from './entity-resolver.js';

export interface ProcessingOptions {
  // Whether to create new entity files
  createEntities: boolean;
  // Whether to apply changes (false = preview only)
  preview: boolean;
  // Minimum confidence for wikilinks
  minWikilinkConfidence: number;
  // Entity types to extract
  entityTypes: string[];
  // Whether to cross-reference with Regen KOI
  crossReferenceKOI: boolean;
}

export interface NewEntityFile {
  path: string;
  name: string;
  type: string;
  frontmatter: Record<string, any>;
  content: string;
  context: string;  // From extraction
}

export interface ProcessingResult {
  // The document path processed
  documentPath: string;
  // Extracted entities
  entities: ExtractedEntity[];
  // Resolution results
  resolutions: Map<string, ResolutionResult>;
  // Suggested wikilinks to insert
  wikilinks: SuggestedWikilink[];
  // Suggested frontmatter additions
  frontmatter: Record<string, any>;
  // New entity files to create
  newEntities: NewEntityFile[];
  // Modified document content (if preview=false)
  modifiedContent?: string;
  // Summary statistics
  stats: {
    entitiesExtracted: number;
    entitiesResolved: number;
    newEntitiesSuggested: number;
    wikilinksAdded: number;
  };
}

const DEFAULT_OPTIONS: ProcessingOptions = {
  createEntities: false,
  preview: true,
  minWikilinkConfidence: 0.7,
  entityTypes: ['Person', 'Organization', 'Location', 'Project', 'Concept'],
  crossReferenceKOI: false
};

/**
 * Document Processor class
 */
export class DocumentProcessor {
  private resolver: EntityResolver;
  private vaultEntities: VaultEntity[] = [];
  private options: ProcessingOptions;

  constructor(options: Partial<ProcessingOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.resolver = createResolver();
  }

  /**
   * Load vault entities for resolution
   */
  loadVaultEntities(entities: VaultEntity[]): void {
    this.vaultEntities = entities;
    this.resolver.loadEntities(entities);
  }

  /**
   * Process a document
   * Note: Actual LLM extraction happens externally - this method receives the response
   */
  async processDocument(
    documentPath: string,
    documentContent: string,
    extractionResponse: string
  ): Promise<ProcessingResult> {
    // Parse the LLM extraction response
    const parsed = parseExtractionResponse(extractionResponse);

    if (!parsed) {
      throw new Error('Failed to parse entity extraction response');
    }

    // Convert parsed entities to ExtractedEntity format with offsets
    const entities: ExtractedEntity[] = [];

    for (const entity of parsed.entities) {
      // Filter by configured entity types
      if (!this.options.entityTypes.includes(entity.type)) {
        continue;
      }

      // Find mention offsets in document
      const mentionOffsets = findMentionOffsets(documentContent, entity.mentions);

      entities.push({
        name: entity.name,
        type: entity.type as ExtractedEntity['type'],
        mentions: mentionOffsets,
        confidence: entity.confidence,
        context: entity.context
      });
    }

    // Resolve entities against vault
    const resolutions = this.resolver.resolveAll(
      entities.map(e => ({ name: e.name, type: e.type }))
    );

    // Generate wikilinks for resolved entities
    const resolvedMap = new Map<string, { path: string; confidence: number } | null>();
    for (const [name, result] of resolutions) {
      if (result.matchedTo) {
        resolvedMap.set(name, {
          path: result.matchedTo,
          confidence: result.confidence
        });
      } else {
        resolvedMap.set(name, null);
      }
    }

    const allWikilinks = generateSuggestedWikilinks(entities, resolvedMap);

    // Filter wikilinks by confidence
    const wikilinks = allWikilinks.filter(
      w => w.confidence >= this.options.minWikilinkConfidence
    );

    // Generate frontmatter suggestions
    const frontmatter = generateSuggestedFrontmatter(
      entities,
      parsed.topics || [],
      parsed.documentType
    );

    // Identify new entities to create
    const newEntities: NewEntityFile[] = [];

    if (this.options.createEntities) {
      for (const [name, result] of resolutions) {
        if (result.matchType === 'new') {
          const entity = entities.find(e => e.name === name);
          if (entity) {
            const suggestedPath = this.resolver.getSuggestedPath(name, result.type);
            newEntities.push({
              path: suggestedPath,
              name: name,
              type: result.type,
              frontmatter: {
                '@type': `schema:${result.type}`,
                name: name,
                created: new Date().toISOString()
              },
              content: `# ${name}\n\n${entity.context || ''}`,
              context: entity.context || ''
            });
          }
        }
      }
    }

    // Generate modified content with wikilinks (if not preview)
    let modifiedContent: string | undefined;

    if (!this.options.preview) {
      modifiedContent = this.applyWikilinks(documentContent, wikilinks);
    }

    // Calculate stats
    const stats = {
      entitiesExtracted: entities.length,
      entitiesResolved: [...resolutions.values()].filter(r => r.matchType !== 'new').length,
      newEntitiesSuggested: [...resolutions.values()].filter(r => r.matchType === 'new').length,
      wikilinksAdded: wikilinks.length
    };

    return {
      documentPath,
      entities,
      resolutions,
      wikilinks,
      frontmatter,
      newEntities,
      modifiedContent,
      stats
    };
  }

  /**
   * Compute "protected spans" — regions of the document where wikilinks must
   * NOT be inserted, because doing so would corrupt existing structure:
   *
   * - YAML frontmatter (between the first two `---` fences). Wikilinks in
   *   YAML scalar values break parsing unless explicitly quoted; safer to
   *   skip the region entirely.
   * - Existing wikilink targets `[[...]]` (and aliases). Inserting a
   *   wikilink inside another wikilink's slug or alias produces nested
   *   `[[...[[...]]...]]` which Obsidian renders as raw text.
   * - Markdown link display text and URL `[text](url)`. Injection into
   *   either side breaks rendering; URL-side injection is silent.
   * - Inline code spans `` `code` `` and fenced code blocks ``` ``` ```.
   *
   * Returns array of [start, end) offset pairs (end-exclusive).
   */
  private computeProtectedSpans(content: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];

    // 1. YAML frontmatter — only if document starts with `---\n`
    if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
      const closeIdx = content.indexOf('\n---', 3);
      if (closeIdx !== -1) {
        // Include the closing `---` line so wikilinks aren't inserted on it
        const lineEnd = content.indexOf('\n', closeIdx + 4);
        spans.push([0, lineEnd === -1 ? content.length : lineEnd + 1]);
      }
    }

    // 2. Fenced code blocks ```...```
    {
      const re = /```[\s\S]*?```/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        spans.push([m.index, m.index + m[0].length]);
      }
    }

    // 3. Inline code spans `...` (single-line only; conservative)
    {
      const re = /`[^`\n]+`/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        spans.push([m.index, m.index + m[0].length]);
      }
    }

    // 4. Existing wikilinks [[...]] (including aliases [[X|y]])
    {
      const re = /\[\[[^\]]+\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        spans.push([m.index, m.index + m[0].length]);
      }
    }

    // 5. Markdown links [text](url) — protect both display text and URL.
    //    Use a tolerant pattern: balance not enforced, but greedy on the URL
    //    portion up to the first unescaped `)` keeps replacements out of
    //    long URLs with query strings.
    {
      const re = /\[[^\]\n]*\]\([^)\n]*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        spans.push([m.index, m.index + m[0].length]);
      }
    }

    return spans;
  }

  /**
   * Returns true if the half-open interval [start, end) overlaps any
   * protected span at all.
   */
  private overlapsProtected(
    start: number,
    end: number,
    protectedSpans: Array<[number, number]>,
  ): boolean {
    for (const [pStart, pEnd] of protectedSpans) {
      // Overlap iff start < pEnd && pStart < end
      if (start < pEnd && pStart < end) return true;
    }
    return false;
  }

  /**
   * Apply wikilinks to document content.
   *
   * Skips any wikilink whose offset range falls inside a protected span
   * (YAML frontmatter, existing wikilinks, markdown links, code spans/blocks).
   * Without this guard, naive replacement corrupts already-structured
   * regions — e.g., injects wikilinks INTO YAML scalar values (breaks
   * parsing), INTO existing `[[Tasks/...]]` slugs (breaks rendering), or
   * INTO `[text](url)` markdown link URLs (silently breaks the hyperlink).
   */
  applyWikilinks(content: string, wikilinks: SuggestedWikilink[]): string {
    // Compute protected spans ONCE against the original content. We then
    // apply wikilinks in reverse-offset order so each replacement doesn't
    // shift the offsets of earlier-positioned wikilinks. Because we never
    // insert into protected spans, the protected-span set computed against
    // the original content remains valid throughout the loop.
    const protectedSpans = this.computeProtectedSpans(content);
    let result = content;
    let skipped = 0;

    for (const wikilink of wikilinks) {
      // Skip if this offset overlaps any protected span.
      if (this.overlapsProtected(wikilink.startOffset, wikilink.endOffset, protectedSpans)) {
        skipped++;
        continue;
      }

      // Check that the text at the offset matches what we expect
      const currentText = result.slice(wikilink.startOffset, wikilink.endOffset);

      if (currentText.toLowerCase() === wikilink.originalText.toLowerCase()) {
        // Replace with wikilink
        result = result.slice(0, wikilink.startOffset) +
                 wikilink.replacement +
                 result.slice(wikilink.endOffset);
      }
    }

    if (skipped > 0) {
      // Fire-and-forget logger import to avoid widening this method's deps;
      // logger is already imported at module level for other call sites.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { logger } = require('./logger');
        logger.info(
          `applyWikilinks: skipped ${skipped} wikilinks that fell inside protected spans (frontmatter / existing wikilinks / markdown links / code)`,
        );
      } catch {
        // logger optional
      }
    }

    return result;
  }

  /**
   * Build the extraction prompt for this document
   */
  buildPrompt(documentContent: string): string {
    return buildExtractionPrompt(documentContent, this.vaultEntities);
  }

  /**
   * Format processing result for display
   */
  formatResultSummary(result: ProcessingResult): string {
    const lines: string[] = [];

    lines.push(`## Processing Result: ${result.documentPath}`);
    lines.push('');
    lines.push(`### Statistics`);
    lines.push(`- Entities extracted: ${result.stats.entitiesExtracted}`);
    lines.push(`- Entities resolved: ${result.stats.entitiesResolved}`);
    lines.push(`- New entities suggested: ${result.stats.newEntitiesSuggested}`);
    lines.push(`- Wikilinks to add: ${result.stats.wikilinksAdded}`);
    lines.push('');

    // Entities by type
    lines.push(`### Extracted Entities`);
    const byType = new Map<string, ExtractedEntity[]>();
    for (const entity of result.entities) {
      const list = byType.get(entity.type) || [];
      list.push(entity);
      byType.set(entity.type, list);
    }

    for (const [type, entities] of byType) {
      lines.push(`\n**${type}s:**`);
      for (const entity of entities) {
        const resolution = result.resolutions.get(entity.name);
        const status = resolution?.matchType === 'new' ? '🆕 NEW' :
                      resolution?.matchType === 'exact' ? '✅ EXACT' :
                      resolution?.matchType === 'alias' ? '✅ ALIAS' :
                      resolution?.matchType === 'fuzzy' ? `⚡ FUZZY (${(resolution.confidence * 100).toFixed(0)}%)` :
                      '❓';
        const target = resolution?.matchedTo || `${type}s/${entity.name}`;
        lines.push(`- ${entity.name} → ${status} → [[${target}]]`);
      }
    }

    // Suggested frontmatter
    if (Object.keys(result.frontmatter).length > 0) {
      lines.push('');
      lines.push(`### Suggested Frontmatter`);
      lines.push('```yaml');
      for (const [key, value] of Object.entries(result.frontmatter)) {
        if (Array.isArray(value)) {
          lines.push(`${key}:`);
          for (const item of value) {
            lines.push(`  - ${JSON.stringify(item)}`);
          }
        } else {
          lines.push(`${key}: ${JSON.stringify(value)}`);
        }
      }
      lines.push('```');
    }

    // New entities to create
    if (result.newEntities.length > 0) {
      lines.push('');
      lines.push(`### New Entity Files to Create`);
      for (const newEntity of result.newEntities) {
        lines.push(`- **${newEntity.path}.md** (${newEntity.type})`);
        if (newEntity.context) {
          lines.push(`  > ${newEntity.context}`);
        }
      }
    }

    // Wikilinks preview
    if (result.wikilinks.length > 0) {
      lines.push('');
      lines.push(`### Wikilinks to Insert (${result.wikilinks.length})`);
      const shown = result.wikilinks.slice(0, 10);
      for (const wl of shown) {
        lines.push(`- "${wl.originalText}" → ${wl.replacement}`);
      }
      if (result.wikilinks.length > 10) {
        lines.push(`- ... and ${result.wikilinks.length - 10} more`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * Create a document processor with default options
 */
export function createProcessor(options?: Partial<ProcessingOptions>): DocumentProcessor {
  return new DocumentProcessor(options);
}
