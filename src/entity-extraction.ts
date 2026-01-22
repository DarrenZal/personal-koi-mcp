/**
 * Entity Extraction Module
 *
 * Extracts entities from document content for linking with vault notes.
 * Uses structured prompts to identify people, organizations, locations, and concepts.
 */

export interface ExtractedEntity {
  name: string;
  type: 'Person' | 'Organization' | 'Location' | 'Concept' | 'Project';
  mentions: Array<{
    text: string;
    startOffset: number;
    endOffset: number;
  }>;
  confidence: number;
  context?: string;  // Brief context about the entity from the document
}

export interface SuggestedWikilink {
  originalText: string;
  replacement: string;
  existingNote: string | null;
  entityType: string;
  confidence: number;
  startOffset: number;
  endOffset: number;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  suggestedWikilinks: SuggestedWikilink[];
  suggestedFrontmatter: Record<string, any>;
  topics: string[];
}

export interface VaultEntity {
  name: string;
  type: string;
  path: string;
  aliases: string[];
}

/**
 * Build the extraction prompt with context about existing vault entities
 */
export function buildExtractionPrompt(
  documentContent: string,
  existingEntities: VaultEntity[]
): string {
  // Group entities by type for the prompt
  const entityGroups: Record<string, string[]> = {};
  for (const entity of existingEntities) {
    const type = entity.type || 'Unknown';
    if (!entityGroups[type]) {
      entityGroups[type] = [];
    }
    const names = [entity.name, ...entity.aliases].filter(Boolean);
    entityGroups[type].push(names.join(' / '));
  }

  // Build entity context section
  let entityContext = '';
  if (existingEntities.length > 0) {
    entityContext = `\n## Existing Vault Entities (prefer matching these):\n`;
    for (const [type, names] of Object.entries(entityGroups)) {
      entityContext += `\n### ${type}s:\n`;
      entityContext += names.slice(0, 50).map(n => `- ${n}`).join('\n');
      if (names.length > 50) {
        entityContext += `\n- ... and ${names.length - 50} more`;
      }
    }
  }

  return `Extract entities from the following document. Identify:

1. **People** - Named individuals (authors, researchers, experts, officials)
2. **Organizations** - Companies, government agencies, NGOs, universities, First Nations
3. **Locations** - Geographic places, bodies of water, regions
4. **Projects** - Named initiatives, programs, or research projects
5. **Concepts** - Key topics, technical terms, or themes central to the document

For each entity:
- Provide the canonical name (normalized form)
- List all mentions/variations found in the text
- Rate confidence (0-1) based on clarity of identification
- Provide brief context about the entity's role in the document
${entityContext}

## Important Guidelines:
- Match existing vault entities when possible (prefer exact/close matches)
- For organizations, use full formal names (e.g., "Fisheries and Oceans Canada" not just "DFO")
- Include common abbreviations as mentions
- Skip generic/common terms unless they're central themes
- Focus on entities that would benefit from linking (named, specific, referenceable)

## Document Content:

${documentContent}

## Response Format (JSON):

\`\`\`json
{
  "entities": [
    {
      "name": "Canonical Name",
      "type": "Person|Organization|Location|Project|Concept",
      "mentions": ["mention1", "mention2"],
      "confidence": 0.95,
      "context": "Brief description of role in document"
    }
  ],
  "topics": ["topic1", "topic2"],
  "documentType": "Article|Report|Meeting Notes|Research Paper|Other"
}
\`\`\``;
}

/**
 * Parse the LLM extraction response
 */
export function parseExtractionResponse(response: string): {
  entities: Array<{
    name: string;
    type: string;
    mentions: string[];
    confidence: number;
    context?: string;
  }>;
  topics: string[];
  documentType?: string;
} | null {
  // Extract JSON from response (might be wrapped in markdown code blocks)
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Try to find JSON object directly
    const objectMatch = response.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Find all occurrences of entity mentions in the document
 */
export function findMentionOffsets(
  content: string,
  mentions: string[]
): Array<{ text: string; startOffset: number; endOffset: number }> {
  const results: Array<{ text: string; startOffset: number; endOffset: number }> = [];

  // Sort mentions by length (longest first) to handle overlapping matches
  const sortedMentions = [...mentions].sort((a, b) => b.length - a.length);

  // Track which ranges we've already matched to avoid overlaps
  const matchedRanges: Array<{ start: number; end: number }> = [];

  for (const mention of sortedMentions) {
    // Create case-insensitive regex with word boundaries
    const escapedMention = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedMention}\\b`, 'gi');

    let match;
    while ((match = regex.exec(content)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // Check if this range overlaps with already matched ranges
      const overlaps = matchedRanges.some(
        range => (start >= range.start && start < range.end) ||
                 (end > range.start && end <= range.end) ||
                 (start <= range.start && end >= range.end)
      );

      if (!overlaps) {
        results.push({
          text: match[0],
          startOffset: start,
          endOffset: end
        });
        matchedRanges.push({ start, end });
      }
    }
  }

  // Sort by offset
  return results.sort((a, b) => a.startOffset - b.startOffset);
}

/**
 * Generate suggested frontmatter based on extracted entities
 */
export function generateSuggestedFrontmatter(
  entities: ExtractedEntity[],
  topics: string[],
  documentType?: string
): Record<string, any> {
  const frontmatter: Record<string, any> = {};

  // Set document type
  if (documentType) {
    frontmatter['@type'] = documentType;
  }

  // Add topics
  if (topics.length > 0) {
    frontmatter.topics = topics;
  }

  // Collect mentions by type
  const mentions: Record<string, string[]> = {};

  for (const entity of entities) {
    if (entity.confidence >= 0.7) {  // Only high-confidence entities
      const key = entity.type.toLowerCase() + 's';  // people, organizations, etc.
      if (!mentions[key]) {
        mentions[key] = [];
      }
      mentions[key].push(entity.name);
    }
  }

  // Add wikilink-formatted mentions
  const allMentions: string[] = [];

  // Add people
  if (mentions.persons && mentions.persons.length > 0) {
    for (const person of mentions.persons) {
      allMentions.push(`[[People/${person}]]`);
    }
  }

  // Add organizations
  if (mentions.organizations && mentions.organizations.length > 0) {
    for (const org of mentions.organizations) {
      allMentions.push(`[[Organizations/${org}]]`);
    }
  }

  // Add locations
  if (mentions.locations && mentions.locations.length > 0) {
    for (const loc of mentions.locations) {
      allMentions.push(`[[Locations/${loc}]]`);
    }
  }

  // Add projects
  if (mentions.projects && mentions.projects.length > 0) {
    for (const proj of mentions.projects) {
      allMentions.push(`[[Projects/${proj}]]`);
    }
  }

  if (allMentions.length > 0) {
    frontmatter.mentions = allMentions;
  }

  return frontmatter;
}

/**
 * Convert extracted entities with offsets to suggested wikilinks
 */
export function generateSuggestedWikilinks(
  entities: ExtractedEntity[],
  resolvedEntities: Map<string, { path: string; confidence: number } | null>
): SuggestedWikilink[] {
  const wikilinks: SuggestedWikilink[] = [];

  for (const entity of entities) {
    const resolved = resolvedEntities.get(entity.name);

    for (const mention of entity.mentions) {
      // Determine the folder based on entity type
      const folder = entity.type === 'Person' ? 'People' :
                     entity.type === 'Organization' ? 'Organizations' :
                     entity.type === 'Location' ? 'Locations' :
                     entity.type === 'Project' ? 'Projects' :
                     'Concepts';

      // Build the wikilink
      const notePath = resolved?.path || `${folder}/${entity.name}`;
      const displayText = mention.text !== entity.name ? mention.text : null;
      const replacement = displayText
        ? `[[${notePath}|${displayText}]]`
        : `[[${notePath}]]`;

      wikilinks.push({
        originalText: mention.text,
        replacement,
        existingNote: resolved?.path || null,
        entityType: entity.type,
        confidence: entity.confidence * (resolved?.confidence || 0.5),
        startOffset: mention.startOffset,
        endOffset: mention.endOffset
      });
    }
  }

  // Sort by offset (reverse order for safe replacement)
  return wikilinks.sort((a, b) => b.startOffset - a.startOffset);
}
