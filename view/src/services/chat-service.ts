import { LLMsAPI } from "@future-scholars/llms-api-service";
import { franc } from "franc";
import { PLAPI, PLExtAPI } from "paperlib-api/api";
import { PaperEntity } from "paperlib-api/model";

import { urlUtils } from "paperlib-api/utils";
import { langCodes } from "@/utils/iso-639-3";
import { EncoderService } from "./encoder-service";
import { useConversationStore } from "@/store/conversation.ts";
import PaperService from "./paper-service.ts";

export class ChatService {
  paperEntity?: PaperEntity;
  private _embeddings: { text: string; embedding: number[] }[] = [];
  embeddingLangCode = "eng";

  private readonly _encoderService: EncoderService;
  private readonly paperService = new PaperService();

  constructor() {
    this._encoderService = new EncoderService();
  }

  async loadPaperEntity(paperEntity: PaperEntity) {
    if (!paperEntity) {
      throw new Error("Paper entity not found");
    }

    this.paperEntity = paperEntity;
  }

  async initializeEncoderWithCache(onProgress?: (progress: number) => void) {
    const id = `${this.paperEntity?._id}`;
    const conversationStore = useConversationStore();
    const cachedConversation = conversationStore.getConversation(id);
    if (
      cachedConversation?.embeddings &&
      cachedConversation.embeddingLangCode
    ) {
      conversationStore.updateConversation(id, {
        timestamp: new Date().valueOf(),
      });
      this._embeddings = cachedConversation.embeddings;
      this.embeddingLangCode = cachedConversation.embeddingLangCode;

      PLAPI.logService.info(
        "Embeddings loaded from cache",
        cachedConversation.embeddingLangCode,
        false,
        "AIChatExt",
      );

      return;
    }
    const encodeResult = await this.initializeEncoder(onProgress);
    if (encodeResult) {
      const { embeddings, embeddingLangCode } = encodeResult;
      conversationStore.setConversation({
        id: id as ReturnType<typeof crypto.randomUUID>,
        embeddings,
        embeddingLangCode,
      });
      this._embeddings = embeddings;
      this.embeddingLangCode = embeddingLangCode;
    }
  }

  async initializeEncoder(onProgress?: (progress: number) => void) {
    if (!this.paperEntity) {
      throw new Error("Paper entity not loaded");
    }

    await this.paperService.init();

    // 1. Load fulltext of the paper.
    const url = await PLAPI.fileService.access(this.paperEntity.mainURL, false);
    if (!url) {
      PLAPI.logService.error(
        "Failed to access the main URL of the paper entity.",
        this.paperEntity.mainURL,
        true,
        "AIChatExt",
      );
      return;
    }

    this._embeddings = [];
    const { embeddings, fulltext } = await this.paperService.encode(
      urlUtils.eraseProtocol(url),
      onProgress,
    );
    let embeddingLangCode: string;
    // 2. Get the language of the paper.
    const lang = this.detectTextLang(fulltext).code;
    PLAPI.logService.info(
      `Detected language: ${lang}`,
      fulltext.slice(0, 500),
      false,
      "AIChatExt",
    );

    embeddingLangCode = lang;

    return { embeddingLangCode, embeddings };
  }

  async retrieveContext(text: string) {
    if (!this.paperEntity) {
      throw new Error("Paper entity not loaded");
    }

    let model = (await PLExtAPI.extensionPreferenceService.get(
      "@future-scholars/paperlib-ai-chat-extension",
      "ai-model",
    )) as string;

    const customModelCode = (await PLExtAPI.extensionPreferenceService.get(
      "@future-scholars/paperlib-ai-chat-extension",
      "customModelCode",
    )) as string;

    if (customModelCode) {
      model = customModelCode;
    }

    let contextParagNum = 0;
    if (model === "gpt-3.5-turbo") {
      contextParagNum = 1;
    } else {
      contextParagNum = 2;
    }

    return await this._encoderService.retrieve(
      text,
      this._embeddings,
      contextParagNum,
    );
  }

  async llmConfig() {
    let model = (await PLExtAPI.extensionPreferenceService.get(
      "@future-scholars/paperlib-ai-chat-extension",
      "ai-model",
    )) as string;

    const customModelCode = (await PLExtAPI.extensionPreferenceService.get(
      "@future-scholars/paperlib-ai-chat-extension",
      "customModelCode",
    )) as string;

    if (customModelCode) {
      model = customModelCode;
    }

    const customAPIURL = (await PLExtAPI.extensionPreferenceService.get(
      "@future-scholars/paperlib-ai-chat-extension",
      "customAPIURL",
    )) as string;

    let apiKey = "";
    let customParameters: Record<string, any> = {};

    if (customAPIURL) {
      // Use custom API settings if URL is provided
      apiKey = (await PLExtAPI.extensionPreferenceService.get(
        "@future-scholars/paperlib-ai-chat-extension",
        "customAPIKey",
      )) as string;
      const customParamsStr = (await PLExtAPI.extensionPreferenceService.get(
        "@future-scholars/paperlib-ai-chat-extension",
        "customParameters",
      )) as string;
      try {
        customParameters = JSON.parse(customParamsStr || "{}");
      } catch (error) {
        PLAPI.logService.error(
          "Failed to parse custom parameters JSON",
          customParamsStr,
          true,
          "AIChatExt",
        );
        customParameters = {}; // Fallback to empty object on parse error
      }
    } else {
      // Use built-in model settings
      const modelServiceProvider = LLMsAPI.modelServiceProvider(model);
      if (modelServiceProvider === "Gemini") {
        apiKey = (await PLExtAPI.extensionPreferenceService.get(
          "@future-scholars/paperlib-ai-chat-extension",
          "gemini-api-key",
        )) as string;
      } else if (modelServiceProvider === "OpenAI") {
        apiKey = (await PLExtAPI.extensionPreferenceService.get(
          "@future-scholars/paperlib-ai-chat-extension",
          "openai-api-key",
        )) as string;
      } else if (modelServiceProvider === "Perplexity") {
        apiKey = (await PLExtAPI.extensionPreferenceService.get(
          "@future-scholars/paperlib-ai-chat-extension",
          "perplexity-api-key",
        )) as string;
      } else if (modelServiceProvider === "Zhipu") {
        apiKey = (await PLExtAPI.extensionPreferenceService.get(
          "@future-scholars/paperlib-ai-chat-extension",
          "zhipu-api-key",
        )) as string;
      }
    }

    return { model, customAPIURL, apiKey, customParameters };
  }

  async queryLLM(msg: string, context: string, anwserLang: string = "English") {
    const { model, customAPIURL, apiKey, customParameters } = await this.llmConfig();

    const query = `I'm reading a paper, I have a question: ${msg}. Please help me answer it with the following context: ${context}.`;

    const answer = await LLMsAPI.model(model)
      .setSystemInstruction(
        `You are a academic paper explainer, skilled in explaining content of a paper. You should answer the question in ${anwserLang}.`,
      )
      .setAPIKey(apiKey)
      .setAPIURL(customAPIURL)
      .query(
        query,
        customParameters,
        async (url: string, headers: Record<string, string>, body: any) => {
          const response = (await PLExtAPI.networkTool.post(
            url,
            body,
            headers,
            0,
            300000,
            false,
            true,
          )) as any;

          if (
            response.body instanceof String ||
            typeof response.body === "string"
          ) {
            return JSON.parse(response.body);
          } else {
            return response.body;
          }
        },
        true,
      );

    // render markdown
    const htmlAnswer = (await PLAPI.renderService.renderMarkdown(answer, true))
      .renderedStr;

    return htmlAnswer;
  }

  detectTextLang(text: string) {
    let langCode = franc(text, { minLength: 10 });
    langCode = !langCode || langCode === "und" ? "eng" : langCode;

    return { code: langCode, name: langCodes[langCode] };
  }

  async translateText(text: string, target: string = "English") {
    const { model, customAPIURL, apiKey } = await this.llmConfig();

    let additionalArgs: any = undefined;
    if (LLMsAPI.modelServiceProvider(model) === "Gemini") {
      additionalArgs = {
        generationConfig: { responseMimeType: "application/json" },
      };
    } else if (
      LLMsAPI.modelServiceProvider(model) === "OpenAI" &&
      (model === "gpt-3.5-turbo-1106" ||
        model === "gpt-4-turbo" ||
        model === "gpt-4o")
    ) {
      additionalArgs = {
        response_format: { type: "json_object" },
      };
    }

    const query = `Translate the following text to ${target}: ${text}`;

    try {
      const response = await LLMsAPI.model(model)
        .setSystemInstruction(
          `You are a professional translator. Please just give me a JSON stringified string like {"translationResult": "..."} without any other content, which can be directly parsed by JSON.parse().`,
        )
        .setAPIKey(apiKey)
        .setAPIURL(customAPIURL)
        .query(
          query,
          additionalArgs,
          async (url: string, headers: Record<string, string>, body: any) => {
            const response = (await PLExtAPI.networkTool.post(
              url,
              body,
              headers,
              0,
              300000,
              false,
              true,
            )) as any;

            if (
              response.body instanceof String ||
              typeof response.body === "string"
            ) {
              return JSON.parse(response.body);
            } else {
              return response.body;
            }
          },
          true,
        );

      const translation = LLMsAPI.parseJSON(response)
        .translationResult as string;
      return translation;
    } catch (error) {
      PLAPI.logService.error(
        `Failed to translate ${text} to ${target}.`,
        error as Error,
        true,
        "AIChatExt",
      );
      return text;
    }
  }
}
