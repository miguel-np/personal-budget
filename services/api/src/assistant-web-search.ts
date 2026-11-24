import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  LocalAiBusyError,
  LocalAiCancelledError,
  LocalAiContextBudgetError,
  LocalAiToolCallUnsupportedError,
  LocalAiUnavailableError,
} from './local-ai.js';
import type { LocalAiClient, WebResearchRequest } from './local-ai.js';
import {
  WebSearchResponseTooLargeError,
  WebSearchUnavailableError,
} from './web-search.js';
import type { WebSearchProvider } from './web-search.js';
import type { AppConfig } from './config.js';
import { OFFICIAL_SOURCE_DOMAINS } from './web-search.js';
import { buildClaimEvidence, shouldAbstainFromTaxConclusion } from './claim-evidence.js';

const TAX_RESEARCH_ABSTENTION_ANSWER = 'La investigación se abstiene de ofrecer una conclusión categórica: al menos una afirmación no tiene evidencia documental literal verificable o existe una posible discrepancia sin resolver. Consulta las fuentes y fragmentos asociados. La coincidencia literal no demuestra que la fuente respalde la afirmación ni su aplicabilidad jurídica.';

type ParsedWebResearchRequest = Omit<WebResearchRequest,
  'jurisdiction' | 'autonomousCommunity' | 'municipality' | 'taxpayerType' |
  'eventDate' | 'matter' | 'taxYear' | 'filingYear' | 'referenceDate'
> & {
  readonly domains: readonly string[];
  readonly jurisdiction?: string | undefined;
  readonly autonomousCommunity?: string | undefined;
  readonly municipality?: string | undefined;
  readonly taxpayerType?: WebResearchRequest['taxpayerType'] | undefined;
  readonly eventDate?: string | undefined;
  readonly matter?: string | undefined;
  readonly taxYear?: string | undefined;
  readonly filingYear?: string | undefined;
  readonly referenceDate?: string | undefined;
};

type SanitizedError = {
  readonly statusCode: number;
  readonly body: { readonly error: { readonly code: string; readonly message: string } };
};

export interface AssistantWebSearchDependencies {
  readonly config: AppConfig;
  readonly localAi: LocalAiClient;
  readonly webSearchProvider: WebSearchProvider;
  readonly allowWebSearchRequest: () => boolean;
  readonly sanitizedErrorResponse: (error: unknown) => SanitizedError;
}

type SearchFailure = {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly retryAfter?: string;
};

function readinessFailure(
  query: ParsedWebResearchRequest,
  dependencies: AssistantWebSearchDependencies,
): SearchFailure | null {
  if (!dependencies.config.aiEnabled) {
    return {
      statusCode: 503, code: 'AI_DISABLED',
      message: 'Activa Ollama local para sintetizar los resultados; las funciones financieras siguen disponibles.',
    };
  }
  if (!dependencies.config.webSearchEnabled) {
    return {
      statusCode: 503, code: 'WEB_SEARCH_DISABLED',
      message: 'La búsqueda externa está desactivada. Habilítala expresamente en la configuración y confirma cada consulta.',
    };
  }
  if (query.query.length > dependencies.config.webSearchMaxQueryChars) {
    return {
      statusCode: 400, code: 'WEB_SEARCH_QUERY_TOO_LONG',
      message: 'La consulta supera el límite configurado.',
    };
  }
  if (!dependencies.allowWebSearchRequest()) {
    return {
      statusCode: 429, code: 'WEB_SEARCH_RATE_LIMIT',
      message: 'Se ha alcanzado el límite local de búsquedas. Inténtalo más tarde.',
      retryAfter: '60',
    };
  }
  return null;
}

function buildModelRequest(query: WebResearchRequest): WebResearchRequest {
  if (query.mode !== 'tax') return { query: query.query, mode: query.mode };
  return {
    query: query.query,
    mode: query.mode,
    jurisdiction: query.jurisdiction!,
    ...(query.autonomousCommunity ? { autonomousCommunity: query.autonomousCommunity } : {}),
    ...(query.municipality ? { municipality: query.municipality } : {}),
    ...(query.taxpayerType ? { taxpayerType: query.taxpayerType } : {}),
    ...(query.eventDate ? { eventDate: query.eventDate } : {}),
    matter: query.matter!,
    taxYear: query.taxYear!,
    filingYear: query.filingYear!,
    referenceDate: query.referenceDate!,
  };
}

function buildSearchResponse(query: ParsedWebResearchRequest, researched: Awaited<ReturnType<LocalAiClient['researchWithWebSearch']>>) {
  const claimEvidence = buildClaimEvidence(
    researched.evidenceAnswer,
    researched.search.sources,
    { requirePrimaryPublication: query.mode === 'tax' },
  );
  const shouldAbstain = query.mode === 'tax' && shouldAbstainFromTaxConclusion(claimEvidence);
  return { data: {
    answer: shouldAbstain ? TAX_RESEARCH_ABSTENTION_ANSWER : researched.answer,
    claimEvidence,
    provider: researched.search.provider,
    searchedAt: researched.search.searchedAt,
    mode: query.mode,
    ...(query.mode === 'tax' ? {
      taxContext: {
        jurisdiction: query.jurisdiction,
        autonomousCommunity: query.autonomousCommunity ?? null,
        municipality: query.municipality ?? null,
        taxpayerType: query.taxpayerType ?? null,
        eventDate: query.eventDate ?? null,
        matter: query.matter,
        taxYear: query.taxYear,
        filingYear: query.filingYear,
        referenceDate: query.referenceDate,
      },
    } : {}),
    sources: researched.search.sources,
    sourceCount: researched.search.sources.length,
  } };
}

function sendSearchError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  sanitizedErrorResponse: (error: unknown) => SanitizedError,
) {
  if (error instanceof LocalAiCancelledError) {
    if (request.raw.aborted || reply.raw.destroyed) return;
    return reply.code(499).send({
      error: { code: 'AI_CANCELLED', message: 'La investigación local se ha cancelado.' },
    });
  }
  if (error instanceof LocalAiBusyError) {
    return reply.code(503).header('retry-after', '1').send({
      error: { code: 'AI_BUSY', message: 'Ollama está ocupado; vuelve a intentarlo en unos segundos.' },
    });
  }
  if (error instanceof LocalAiContextBudgetError) {
    return reply.code(413).send({
      error: { code: 'AI_CONTEXT_TOO_LARGE', message: 'La consulta o sus fuentes superan el límite local permitido.' },
    });
  }
  if (error instanceof LocalAiToolCallUnsupportedError) {
    return reply.code(422).send({
      error: { code: 'WEB_SEARCH_TOOL_UNSUPPORTED', message: 'El modelo local no ha solicitado correctamente la herramienta web_search. Selecciona un modelo compatible con tool calling y vuelve a intentarlo.' },
    });
  }
  if (error instanceof WebSearchResponseTooLargeError) {
    return reply.code(502).send({
      error: { code: 'WEB_SEARCH_RESPONSE_TOO_LARGE', message: 'El proveedor devolvió una respuesta superior al límite permitido.' },
    });
  }
  if (error instanceof WebSearchUnavailableError) {
    return reply.code(503).send({
      error: { code: 'WEB_SEARCH_UNAVAILABLE', message: 'SearXNG no está disponible o devolvió una respuesta no válida. El asistente financiero local sigue funcionando.' },
    });
  }
  if (error instanceof LocalAiUnavailableError) {
    return reply.code(503).send({
      error: { code: 'AI_UNAVAILABLE', message: 'Ollama no ha podido completar la investigación local.' },
    });
  }
  const normalized = sanitizedErrorResponse(error);
  return reply.code(normalized.statusCode).send(normalized.body);
}

export async function handleAssistantWebSearch(
  query: ParsedWebResearchRequest,
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AssistantWebSearchDependencies,
) {
  const requestAbort = new AbortController();
  const abortRequest = () => requestAbort.abort();
  const abortResponse = () => { if (!reply.raw.writableEnded) requestAbort.abort(); };
  request.raw.once('aborted', abortRequest);
  reply.raw.once('close', abortResponse);
  try {
    const failure = readinessFailure(query, dependencies);
    if (failure) {
      const response = reply.code(failure.statusCode);
      if (failure.retryAfter) response.header('retry-after', failure.retryAfter);
      return response.send({ error: { code: failure.code, message: failure.message } });
    }
    const domains: readonly string[] = query.mode === 'tax'
      ? (query.domains.length > 0 ? query.domains : OFFICIAL_SOURCE_DOMAINS)
      : query.domains;
    const researched = await dependencies.localAi.researchWithWebSearch(
      buildModelRequest(query), dependencies.webSearchProvider, domains, requestAbort.signal,
    );
    return buildSearchResponse(query, researched);
  } catch (error) {
    return sendSearchError(error, request, reply, dependencies.sanitizedErrorResponse);
  } finally {
    request.raw.removeListener('aborted', abortRequest);
    reply.raw.removeListener('close', abortResponse);
  }
}
