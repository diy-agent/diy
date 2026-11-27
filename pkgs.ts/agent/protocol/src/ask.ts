// ask.ts —— 提问的**纯函数**：归一化旧形状、把一题的回答整理成模型能读懂的一行。
//
// 这里是唯一的实现点：闸门（entity-runtime）拼投递消息、UI 读快照里的旧卡片、
// 工具回执，都从这里取，不再各写一份。否则同一份答案会有三种表述，模型会当成三件事。

import type { AskAnswer, AskQuestion, AskQuestionAnswer, AskRequest } from './types';

/** 是不是一个像样的题目（旧快照 / 手写数据里可能缺东少西） */
function isQuestion(value: unknown): value is AskQuestion {
    if (value === null || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return typeof record['question'] === 'string' && record['question'] !== '';
}

/** 旧的单问题形状（2026-11 之前落库的快照里还有）：question / kind / options / fields 在顶层 */
function legacyQuestion(raw: Record<string, unknown>): AskQuestion | undefined {
    if (!isQuestion(raw)) return undefined;
    const kind = raw['kind'];
    const fields = raw['fields'];
    return {
        id: 'q1',
        question: raw['question'] as string,
        kind: kind === 'form' || kind === 'text' || kind === 'choice' ? kind : fields === undefined ? 'choice' : 'form',
        ...(raw['options'] === undefined ? {} : { options: raw['options'] as AskQuestion['options'] }),
        ...(fields === undefined ? {} : { fields: fields as AskQuestion['fields'] }),
        ...(raw['multiple'] === undefined ? {} : { multiple: raw['multiple'] as boolean }),
        ...(raw['allowFreeform'] === undefined ? {} : { allowFreeform: raw['allowFreeform'] as boolean }),
        ...(raw['note'] === undefined ? {} : { note: raw['note'] as string }),
    };
}

/**
 * 任意来源的提问 → 当前形状。**只做补全，不猜内容**。
 *
 * 为什么要它：`AskRequest` 从"一个问题"改成"一批问题"之前落进快照的卡片还在库里
 * （`answeredAsks`）。不归一化，刷新一下旧卡片就整块渲不出来 —— 而它们正是用户
 * 回头核对"当时我选了哪个"的唯一线索。
 *
 * 认不出来的返回 undefined（调用方丢掉那一张，不要造一张空卡片）。
 */
export function normalizeAskRequest(value: unknown): AskRequest | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const askId = typeof raw['askId'] === 'string' ? raw['askId'] : undefined;
    if (askId === undefined) return undefined;

    const rawQuestions = Array.isArray(raw['questions']) ? raw['questions'].filter(isQuestion) : [];
    const questions: AskQuestion[] =
        rawQuestions.length > 0
            ? rawQuestions.map((question, index) => ({
                  ...question,
                  id: typeof question.id === 'string' && question.id !== '' ? question.id : `q${index + 1}`,
                  kind:
                      question.kind === 'form' || question.kind === 'text' || question.kind === 'choice'
                          ? question.kind
                          : question.fields === undefined
                            ? 'choice'
                            : 'form',
              }))
            : (() => {
                  const legacy = legacyQuestion(raw);
                  return legacy === undefined ? [] : [legacy];
              })();
    if (questions.length === 0) return undefined;

    return {
        askId,
        questions,
        ...(raw['note'] === undefined ? {} : { note: raw['note'] as string }),
        ...(raw['toolCallId'] === undefined ? {} : { toolCallId: raw['toolCallId'] as string }),
        ...(raw['owner'] === undefined ? {} : { owner: raw['owner'] as string }),
        at: typeof raw['at'] === 'number' ? raw['at'] : 0,
    };
}

/** 单题的答案文本（不含问题本身）—— 投递消息与工具回执共用同一份表述 */
export function describeQuestionAnswer(question: AskQuestion, answer: AskQuestionAnswer | undefined): string {
    if (answer === undefined) return '（没有回答）';
    if (answer.skipped === true) return '（跳过）';
    if (question.kind === 'text') {
        // 注意不能写 `answer.text?.trim() ?? '（空）'`：空串过不了 ??，会拼出「回答提问「…」：」后面什么都没有
        const text = answer.text?.trim() ?? '';
        return text === '' ? '（空）' : text;
    }
    if (question.kind === 'form') {
        const lines = (question.fields ?? []).map(
            (field) => `- ${field.label}：${answer.fields?.[field.name] ?? '（未填）'}`,
        );
        const extra = answer.text?.trim() ?? '';
        const body = lines.length === 0 ? '（没有字段）' : lines.join('\n');
        return extra === '' ? body : `${body}\n补充：${extra}`;
    }
    const values = answer.values ?? [];
    const freeText = answer.text?.trim() ?? '';
    // 只填了自由输入、没勾选项：这段文字是用户唯一的回答，不能丢
    if (values.length === 0) return freeText === '' ? '（空）' : freeText;
    const labels = values.map((value) => {
        const option = question.options?.find((candidate) => candidate.value === value);
        // label 和 value 一样时不再重复（常见于 `{value:'json'}` 省了 label）：
        // 「json（json）」只有噪音，模型也不会因此多知道什么
        if (option === undefined || option.label === value) return value;
        return `${option.label}（${value}）`;
    });
    const picked = labels.join('、');
    return freeText === '' ? picked : `${picked}；补充：${freeText}`;
}

/** 按题 id 取这一题的答案 */
export function answerFor(answer: AskAnswer | undefined, questionId: string): AskQuestionAnswer | undefined {
    return answer?.answers.find((entry) => entry.id === questionId);
}

/**
 * 一批答案压成模型能直接读懂的文本。
 *
 * 单题不带问题前缀（`回答提问「…」` 已经把问题写在外面了）；
 * 多题逐行 `- 问题 → 答案`，一屏对上，不用模型自己去数组里配对。
 */
export function describeAnswer(request: AskRequest, answer: AskAnswer | undefined): string {
    if (answer === undefined) return '（没有回答）';
    if (request.questions.length === 1) {
        const question = request.questions[0]!;
        return describeQuestionAnswer(question, answerFor(answer, question.id));
    }
    return request.questions
        .map(
            (question) =>
                `- ${question.question} → ${describeQuestionAnswer(question, answerFor(answer, question.id))}`,
        )
        .join('\n');
}

/** 投递给用户的那条消息的标题行：一题照旧，多题标明数量 */
export function askAnswerHeading(request: AskRequest): string {
    if (request.questions.length === 1) return `回答提问「${request.questions[0]!.question}」：`;
    return `回答提问（${request.questions.length} 题）：`;
}
