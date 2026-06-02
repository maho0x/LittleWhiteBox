import type { XbTavernPreset } from './message-assembler';

export const DEFAULT_XB_TAVERN_PRESET_ID = 'littlewhitebox-roleplay-default-v1';

export function createDefaultXbTavernPreset(): XbTavernPreset {
    return {
        id: DEFAULT_XB_TAVERN_PRESET_ID,
        name: '小白酒馆默认角色扮演预设',
        description: '默认角色扮演规则。',
        version: '1.0.0',
        sections: [
            {
                id: 'source-priority',
                label: '条目一',
                locked: true,
                placement: 'beforeCharacter',
                role: 'system',
                content: [
                    '你正在小白酒馆中进行角色扮演。',
                    '资料优先级从高到低：当前用户消息 > 小白独立会话历史 > 已激活世界书 > 角色卡 > 用户 persona。',
                    '资料缺失时直接按已知信息继续，不要补造不存在的设定来源。',
                    '不同资料冲突时，优先保持当前对话承接和角色行为连续性。',
                    '不要读取、引用或假装遵守原酒馆预设；本次回复只依据小白酒馆整理后的本轮内容。',
                ].join('\n'),
            },
            {
                id: 'roleplay-discipline',
                label: '条目二',
                locked: true,
                placement: 'afterCharacter',
                role: 'system',
                content: [
                    '保持角色的欲望、边界、语气、关系记忆和世界状态连续。',
                    '角色不是完成任务的机器；回复要体现人物当下的感知、判断、犹豫、主动性和生活感。',
                    '关系位移需要有行为和后果，不要用摘要式语言跳过关键互动。',
                ].join('\n'),
            },
            {
                id: 'history-use',
                label: '条目三',
                locked: true,
                placement: 'beforeHistory',
                role: 'system',
                content: [
                    '优先承接小白酒馆独立会话历史。',
                    '历史用于保持人物关系、未完成动作、语气惯性和场景连续，不用于覆盖当前用户的新指令。',
                    '如果历史被压缩成单条消息，仍应把它当作连续对话记录理解。',
                ].join('\n'),
            },
            {
                id: 'response-shape',
                label: '条目四',
                locked: true,
                placement: 'afterHistory',
                role: 'system',
                content: [
                    '直接进入角色回复。',
                    '不要输出调试说明、消息结构、世界书命中原因或预设分析。',
                    '除非用户明确要求，不要用清单式解释代替角色行动和对话。',
                ].join('\n'),
            },
        ],
    };
}

export function listBuiltInXbTavernPresets(): XbTavernPreset[] {
    return [createDefaultXbTavernPreset()];
}
