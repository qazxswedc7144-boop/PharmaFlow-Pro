/**
 * PharmaFlow AI Copilot - Floating Widget Launcher
 * Non-intrusive floating trigger button providing access to the Smart Pharmacy Copilot drawer.
 */

import React, { useState, useCallback, memo, useEffect } from 'react';
import { motion } from 'motion/react';
import { Bot, Sparkles } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useUIStore } from '@/store/useUIStore';
import { AIUserContext } from '@/services/ai/types';
import { CopilotDrawer } from './CopilotDrawer';

export const CopilotWidget: React.FC = memo(() => {
  const [isOpen, setIsOpen] = useState(false);
  const { user } = useAuthStore();
  const isSubscriptionOnboardingOpen = useUIStore((state) => state.isSubscriptionOnboardingOpen);

  // Close drawer immediately if welcome onboarding modal is triggered
  useEffect(() => {
    if (isSubscriptionOnboardingOpen && isOpen) {
      setIsOpen(false);
    }
  }, [isSubscriptionOnboardingOpen, isOpen]);

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Strict architectural isolation: Do not render or allow any interaction while Onboarding Modal is active
  if (isSubscriptionOnboardingOpen) {
    return null;
  }

  // Derive standardized AIUserContext from active session
  const rawRole = (user?.role || 'staff').toLowerCase();
  const validRole: AIUserContext['userRole'] =
    rawRole === 'admin' ||
    rawRole === 'pharmacist' ||
    rawRole === 'accountant' ||
    rawRole === 'manager'
      ? rawRole
      : 'staff';

  const userContext: AIUserContext = {
    userId: user?.id || 'usr_anonymous',
    userRole: validRole,
    branchId: user?.branchId || 'main_branch',
    tenantId: user?.tenantId || 'pharmaflow_tenant',
  };

  return (
    <>
      {/* Viewport-fixed Floating Trigger Button */}
      {!isOpen && (
        <div 
          className="fixed inset-x-0 mx-auto w-full pointer-events-none flex justify-end px-4"
          dir="rtl"
          style={{
            position: 'fixed',
            bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
            left: '0px',
            right: '0px',
            maxWidth: 'min(calc(100vw - 32px), 480px)',
            zIndex: 9999,
          }}
        >
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={handleToggle}
            className="pointer-events-auto relative group flex items-center gap-2.5 px-3.5 sm:px-4 py-2.5 sm:py-3 bg-gradient-to-r from-[#1E4D4D] via-[#1a4444] to-[#143737] text-white rounded-2xl shadow-xl shadow-teal-950/40 border border-teal-400/30 cursor-pointer overflow-hidden max-w-full shrink-0"
            title="المساعد الذكي (Smart Copilot)"
          >
            {/* Subtle Ambient Pulse Light */}
            <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-400 rounded-full animate-ping opacity-75" />
            <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white" />

            {/* Icon */}
            <div className="p-1.5 bg-teal-500/20 rounded-xl text-teal-300 group-hover:text-white transition-colors shrink-0">
              <Bot size={18} className="animate-bounce" />
            </div>

            {/* Label */}
            <div className="flex flex-col text-right min-w-0">
              <span className="text-xs font-black tracking-wide flex items-center gap-1 whitespace-nowrap">
                <span>المساعد الذكي</span>
                <Sparkles size={12} className="text-teal-300 shrink-0" />
              </span>
              <span className="text-[10px] text-teal-200/80 font-medium truncate">
                كوبايلوت الصيدلية
              </span>
            </div>
          </motion.button>
        </div>
      )}

      {/* Drawer Overlay */}
      <CopilotDrawer isOpen={isOpen} onClose={handleClose} userContext={userContext} />
    </>
  );
});

CopilotWidget.displayName = 'CopilotWidget';
