/**
 * PharmaFlow AI Copilot - Slide-out Drawer Component
 * Interactive assistant workspace supporting normal & streaming modes, role-based suggestions, and error recovery.
 */

import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Send,
  Trash2,
  Bot,
  Sparkles,
  Zap,
  Radio,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import { GeminiGateway } from '@/services/ai/GeminiGateway';
import { AIUserContext } from '@/services/ai/types';
import { CopilotMessage, CopilotMessageData } from './CopilotMessage';
import { PromptSuggestions } from './PromptSuggestions';

interface CopilotDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  userContext: AIUserContext;
}

export const CopilotDrawer: React.FC<CopilotDrawerProps> = memo(({ isOpen, onClose, userContext }) => {
  const [messages, setMessages] = useState<CopilotMessageData[]>([]);
  const [inputText, setInputText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [useStreaming, setUseStreaming] = useState(true);
  const [taskComplexity, setTaskComplexity] = useState<'simple' | 'medium' | 'complex'>('simple');
  const [showOptions, setShowOptions] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom of chat
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isGenerating, scrollToBottom]);

  // Focus input when drawer opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  // Clear chat history
  const handleClearChat = useCallback(() => {
    if (window.confirm('هل أنت تأكد من مسح محادثة المساعد الذكي؟')) {
      setMessages([]);
    }
  }, []);

  // Primary handler to execute user query
  const handleSendMessage = useCallback(
    async (
      rawPrompt?: string,
      contexts?: Array<'inventory' | 'sales' | 'purchases' | 'financials' | 'drugInfo'>,
      promptId?: string
    ) => {
      const promptToUse = (rawPrompt || inputText).trim();
      if (!promptToUse || isGenerating) return;

      const timestampStr = new Date().toLocaleTimeString('ar-EG', {
        hour: '2-digit',
        minute: '2-digit',
      });

      const userMsgId = `usr_${Date.now()}`;
      const userMessage: CopilotMessageData = {
        id: userMsgId,
        sender: 'user',
        text: promptToUse,
        timestamp: timestampStr,
      };

      const assistantMsgId = `ast_${Date.now()}`;
      const initialAssistantMessage: CopilotMessageData = {
        id: assistantMsgId,
        sender: 'assistant',
        text: '',
        timestamp: timestampStr,
        isStreaming: useStreaming,
      };

      setMessages((prev) => [...prev, userMessage, initialAssistantMessage]);
      setInputText('');
      setIsGenerating(true);

      const requestOptions = {
        rawPrompt: promptToUse,
        userContext,
        promptId,
        includeContexts: contexts || ['inventory', 'sales', 'financials'],
        taskComplexity,
      };

      try {
        if (useStreaming) {
          let accumulatedText = '';
          const streamResult = await GeminiGateway.stream(requestOptions, (chunk: string) => {
            accumulatedText += chunk;
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMsgId ? { ...msg, text: accumulatedText } : msg
              )
            );
          });

          if (!streamResult.success) {
            // Fallback to execute if streaming fails or HTTP error occurs
            console.warn('⚠️ Streaming failed, attempting standard execution fallback...');
            const execResult = await GeminiGateway.execute<string>(requestOptions);
            
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMsgId
                  ? {
                      ...msg,
                      text: execResult.rawOutput,
                      modelUsed: execResult.modelUsed,
                      isStreaming: false,
                      isError: false,
                    }
                  : msg
              )
            );
          } else {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMsgId
                  ? {
                      ...msg,
                      text: accumulatedText || 'تم إكمال الإجابة بنجاح.',
                      isStreaming: false,
                    }
                  : msg
              )
            );
          }
        } else {
          // Standard execution mode
          const execResult = await GeminiGateway.execute<string>(requestOptions);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    text: execResult.rawOutput,
                    modelUsed: execResult.modelUsed,
                    isStreaming: false,
                    isError: false,
                  }
                : msg
            )
          );
        }
      } catch (err: any) {
        console.error('❌ Copilot execution error:', err);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  text: 'حدث خطأ أثناء التواصل مع المساعد الذكي. يُرجى التحقق من الاتصال والمحاولة مجدداً.',
                  isStreaming: false,
                  isError: true,
                }
              : msg
          )
        );
      } finally {
        setIsGenerating(false);
      }
    },
    [inputText, isGenerating, useStreaming, userContext, taskComplexity]
  );

  // Retry last assistant message if failed
  const handleRetry = useCallback(
    (lastUserMsgIndex: number) => {
      const userMsg = messages[lastUserMsgIndex];
      if (userMsg && userMsg.sender === 'user') {
        handleSendMessage(userMsg.text);
      }
    },
    [messages, handleSendMessage]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[9998] pointer-events-auto flex justify-center items-end sm:items-center" dir="rtl" style={{ height: '100dvh' }}>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-[9999]"
          />

          {/* Drawer Panel - Strictly constrained to 480px width matching the main dashboard layout */}
          <motion.div
            initial={{ y: '100%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 28, stiffness: 280 }}
            className="relative z-[10000] w-full max-w-[480px] bg-[#F8FAFA] shadow-2xl flex flex-col border border-slate-200 h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[96dvh] sm:rounded-3xl overflow-hidden"
            style={{
              paddingTop: 'env(safe-area-inset-top, 0px)',
              paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
            }}
            dir="rtl"
          >
            {/* Drawer Header - تم إصلاح المشكلة هنا */}
            <div className="p-3 sm:p-4 bg-gradient-to-r from-[#1E4D4D] to-[#143737] text-white shadow-md flex items-center justify-between shrink-0 gap-2">
              
              {/* حاوية النصوص والأيقونة */}
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-teal-500/20 border border-teal-400/30 flex items-center justify-center text-teal-300 shadow-inner shrink-0">
                  <Bot size={22} className="animate-pulse" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-nowrap min-w-0">
                    <h2 className="text-sm sm:text-base font-black tracking-tight whitespace-nowrap truncate">
                      المساعد الذكي (Pharma Copilot)
                    </h2>
                    <span className="text-[10px] bg-teal-400/20 text-teal-200 border border-teal-300/30 px-2 py-0.5 rounded-full font-bold shrink-0">
                      {userContext.userRole}
                    </span>
                  </div>
                  <p className="text-[10px] sm:text-[11px] text-teal-100/80 whitespace-nowrap truncate">
                    مساعد التخطيط والتحليل والرقابة الصيدلانية
                  </p>
                </div>
              </div>

              {/* حاوية الأزرار */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => setShowOptions((v) => !v)}
                  className={`p-2 rounded-xl transition-colors cursor-pointer ${
                    showOptions ? 'bg-teal-700/80 text-white' : 'text-teal-200 hover:bg-teal-800/60'
                  }`}
                  title="إعدادات الاستجابة"
                >
                  <SlidersHorizontal size={18} />
                </button>
                <button
                  onClick={handleClearChat}
                  disabled={messages.length === 0}
                  className="p-2 text-teal-200 hover:text-rose-300 hover:bg-teal-800/60 rounded-xl transition-colors disabled:opacity-40 cursor-pointer"
                  title="مسح المحادثة"
                >
                  <Trash2 size={18} />
                </button>
                <button
                  onClick={onClose}
                  className="p-2 text-teal-200 hover:text-white hover:bg-teal-800/60 rounded-xl transition-colors cursor-pointer"
                  title="إغلاق"
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Response Options Panel */}
            <AnimatePresence>
              {showOptions && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="bg-teal-900/95 text-teal-100 p-3.5 border-b border-teal-700/50 text-xs overflow-hidden"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    {/* Streaming Toggle */}
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={useStreaming}
                        onChange={(e) => setUseStreaming(e.target.checked)}
                        className="rounded border-teal-600 text-teal-500 focus:ring-0"
                      />
                      <Radio size={14} className={useStreaming ? 'text-teal-300 animate-pulse' : 'text-teal-500'} />
                      <span className="font-bold">بث الاستجابة اللحظي (SSE Mode)</span>
                    </label>

                    {/* Complexity Level */}
                    <div className="flex items-center gap-1 bg-teal-950/60 p-1 rounded-xl border border-teal-800">
                      <Zap size={12} className="text-amber-400" />
                      <span className="text-[10px] text-teal-300 ml-1">تعقيد المهمة:</span>
                      {(['simple', 'medium', 'complex'] as const).map((level) => (
                        <button
                          key={level}
                          onClick={() => setTaskComplexity(level)}
                          className={`text-[10px] px-2 py-0.5 rounded-lg transition-all font-bold cursor-pointer ${
                            taskComplexity === level
                              ? 'bg-teal-500 text-slate-950 shadow-xs'
                              : 'text-teal-300 hover:text-white'
                          }`}
                        >
                          {level === 'simple' ? 'بسيط' : level === 'medium' ? 'متوسط' : 'عميق'}
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Disclaimer Banner */}
            <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 text-[11px] font-bold text-amber-900 flex items-center justify-center gap-1.5 shrink-0">
              <ShieldAlert size={14} className="text-amber-600 shrink-0" />
              <span>المعلومات المقدمة للمراجعة فقط ولا تغني عن القرار المهني الصيدلاني.</span>
            </div>

            {/* Messages Body */}
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-4">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col justify-center items-center py-6 text-center space-y-6">
                  <div className="w-16 h-16 rounded-3xl bg-teal-100/60 border border-teal-200 flex items-center justify-center text-teal-700 shadow-sm">
                    <Sparkles size={32} />
                  </div>
                  <div className="max-w-xs space-y-1">
                    <h3 className="text-sm font-black text-slate-800">أهلاً بك في المساعد الذكي</h3>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      اختر إحدى التوصيات السريعة أدناه أو اكتب استفسارك الخاص لمساعدتك في المبيعات، المخزون، والمالية.
                    </p>
                  </div>

                  {/* Role Suggestions */}
                  <PromptSuggestions
                    userRole={userContext.userRole}
                    onSelectPrompt={(pText, pContexts, pId) => handleSendMessage(pText, pContexts, pId)}
                  />
                </div>
              ) : (
                <>
                  {messages.map((msg, index) => (
                    <CopilotMessage
                      key={msg.id}
                      message={msg}
                      onRetry={msg.isError ? () => handleRetry(index - 1) : undefined}
                    />
                  ))}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            {/* Bottom Input Area */}
            <div className="p-4 bg-white border-t border-slate-200 shrink-0 shadow-lg">
              <div className="flex items-end gap-2 bg-slate-50 border border-slate-200 rounded-2xl p-2 focus-within:border-teal-600 focus-within:ring-2 focus-within:ring-teal-500/20 transition-all">
                <textarea
                  ref={inputRef}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="اسأل المساعد الذكي عن الأدوية، المبيعات، المخزون، أو المالية... (Enter للإرسال)"
                  rows={2}
                  disabled={isGenerating}
                  className="flex-1 bg-transparent border-0 resize-none text-xs text-slate-800 focus:outline-none focus:ring-0 placeholder-slate-400 custom-scrollbar"
                />

                <button
                  onClick={() => handleSendMessage()}
                  disabled={!inputText.trim() || isGenerating}
                  className="p-3 bg-gradient-to-r from-teal-600 to-teal-800 hover:from-teal-700 hover:to-teal-900 text-white rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-teal-900/10 cursor-pointer shrink-0"
                  title="إرسال"
                >
                  {isGenerating ? (
                    <RefreshCw size={18} className="animate-spin" />
                  ) : (
                    <Send size={18} className="rotate-180" />
                  )}
                </button>
              </div>

              <div className="flex items-center justify-between text-[10px] text-slate-400 mt-2 px-1 font-mono">
                <span>نموذج النشاط: {taskComplexity === 'complex' ? 'Gemini 3.1 Pro' : 'Gemini 3.6 Flash'}</span>
                <span>اضغط Enter للإرسال | Shift+Enter للسطر الجديد</span>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
});

CopilotDrawer.displayName = 'CopilotDrawer';
