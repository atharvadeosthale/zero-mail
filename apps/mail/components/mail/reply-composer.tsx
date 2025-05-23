'use client';

import {
  ArrowUp,
  Paperclip,
  Reply,
  X,
  Plus,
  Sparkles,
  Check,
  X as XIcon,
  Forward,
  ReplyAll,
  MinusCircle,
  PlusCircle,
  Minus,
  ChevronDown,
} from 'lucide-react';
import {
  cleanEmailAddress,
  truncateFileName,
  cn,
  convertJSONToHTML,
  createAIJsonContent,
  constructReplyBody,
} from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useRef, useState, useEffect, useCallback, useReducer } from 'react';
import { UploadedFileIcon } from '@/components/create/uploaded-file-icon';
import { EmailInput } from '@/components/create/email-input';
import { useEmailAliases } from '@/hooks/use-email-aliases';
import { extractTextFromHTML } from '@/actions/extractText';
import { useForm, SubmitHandler } from 'react-hook-form';
import { generateAIResponse } from '@/actions/ai-reply';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { Separator } from '@/components/ui/separator';
import { useMail } from '@/components/mail/use-mail';
import { useSettings } from '@/hooks/use-settings';
import { useContacts } from '@/hooks/use-contacts';
import Editor from '@/components/create/editor';
import { Button } from '@/components/ui/button';
import { useThread } from '@/hooks/use-threads';
import { useSession } from '@/lib/auth-client';
import { createDraft } from '@/actions/drafts';
import { useTranslations } from 'next-intl';
import { sendEmail } from '@/actions/send';
import type { JSONContent } from 'novel';
import { useQueryState } from 'nuqs';
import { Input } from '../ui/input';
import posthog from 'posthog-js';
import { Sender } from '@/types';
import { toast } from 'sonner';
import type { z } from 'zod';
import React from 'react';

const DragOverlay = () => {
  const t = useTranslations();
  return (
    <div className="bg-background/80 border-primary/30 absolute inset-0 z-50 m-4 flex items-center justify-center rounded-2xl border-2 border-dashed backdrop-blur-sm">
      <div className="text-muted-foreground flex flex-col items-center gap-2">
        <Paperclip className="text-muted-foreground h-12 w-12" />
        <p className="text-lg font-medium">{t('common.replyCompose.dropFiles')}</p>
      </div>
    </div>
  );
};

// Utility function to check if an email is a noreply address
const isNoReplyAddress = (email: string): boolean => {
  const lowerEmail = email.toLowerCase();
  return (
    lowerEmail.includes('noreply') ||
    lowerEmail.includes('no-reply') ||
    lowerEmail.includes('notifications@github.com')
  );
};

// Define state interfaces
interface ComposerState {
  isUploading: boolean;
  isComposerOpen: boolean;
  isDragging: boolean;
  isEditorFocused: boolean;
  editorKey: number;
  editorInitialValue?: JSONContent;
  hasUnsavedChanges: boolean;
  isLoading: boolean;
}

interface AIState {
  isLoading: boolean;
  suggestion: string | null;
  showOptions: boolean;
}

// Define action types
type ComposerAction =
  | { type: 'SET_UPLOADING'; payload: boolean }
  | { type: 'SET_COMPOSER_OPEN'; payload: boolean }
  | { type: 'SET_DRAGGING'; payload: boolean }
  | { type: 'SET_EDITOR_FOCUSED'; payload: boolean }
  | { type: 'INCREMENT_EDITOR_KEY' }
  | { type: 'SET_EDITOR_INITIAL_VALUE'; payload: JSONContent | undefined }
  | { type: 'SET_UNSAVED_CHANGES'; payload: boolean }
  | { type: 'SET_LOADING'; payload: boolean };

type AIAction =
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_SUGGESTION'; payload: string | null }
  | { type: 'SET_SHOW_OPTIONS'; payload: boolean }
  | { type: 'RESET' };

// Create reducers
const composerReducer = (state: ComposerState, action: ComposerAction): ComposerState => {
  switch (action.type) {
    case 'SET_UPLOADING':
      return { ...state, isUploading: action.payload };
    case 'SET_COMPOSER_OPEN':
      return { ...state, isComposerOpen: action.payload };
    case 'SET_DRAGGING':
      return { ...state, isDragging: action.payload };
    case 'SET_EDITOR_FOCUSED':
      return { ...state, isEditorFocused: action.payload };
    case 'INCREMENT_EDITOR_KEY':
      return { ...state, editorKey: state.editorKey + 1 };
    case 'SET_EDITOR_INITIAL_VALUE':
      return { ...state, editorInitialValue: action.payload };
    case 'SET_UNSAVED_CHANGES':
      return { ...state, hasUnsavedChanges: action.payload };
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
    default:
      return state;
  }
};

const aiReducer = (state: AIState, action: AIAction): AIState => {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
    case 'SET_SUGGESTION':
      return { ...state, suggestion: action.payload };
    case 'SET_SHOW_OPTIONS':
      return { ...state, showOptions: action.payload };
    case 'RESET':
      return { isLoading: false, suggestion: null, showOptions: false };
    default:
      return state;
  }
};

interface ReplyComposeProps {
  mode?: 'reply' | 'replyAll' | 'forward';
}

type FormData = {
  messageContent: string;
  to: string[];
  cc: string[];
  bcc: string[];
  toInput: string;
  ccInput: string;
  bccInput: string;
};

export default function ReplyCompose() {
  const [threadId] = useQueryState('threadId');
  const { data: emailData, mutate } = useThread(threadId);
  const [attachments, setAttachments] = useState<File[]>([]);
  const { data: session } = useSession();
  const [mail, setMail] = useMail();
  const [draftId, setDraftId] = useQueryState('draftId');
  const [mode, setMode] = useQueryState('mode');
  const { enableScope, disableScope } = useHotkeysContext();
  const [isEditingRecipients, setIsEditingRecipients] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [selectedFromEmail, setSelectedFromEmail] = useState<string | null>(null);
  const { aliases, isLoading: isLoadingAliases } = useEmailAliases();
  const ccInputRef = useRef<HTMLInputElement | null>(null);
  const bccInputRef = useRef<HTMLInputElement | null>(null);

  // Use global state instead of local state
  const composerIsOpen = !!mode;

  // Use reducers instead of multiple useState
  const [composerState, composerDispatch] = useReducer(composerReducer, {
    isUploading: false,
    isComposerOpen: false,
    isDragging: false,
    isEditorFocused: false,
    editorKey: 0,
    editorInitialValue: undefined,
    hasUnsavedChanges: false,
    isLoading: false,
  });

  const [aiState, aiDispatch] = useReducer(aiReducer, {
    isLoading: false,
    suggestion: null,
    showOptions: false,
  });

  const composerRef = useRef<HTMLFormElement>(null);
  const t = useTranslations();

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    getValues,
    reset,
    control,
    watch,
  } = useForm<FormData>({
    defaultValues: {
      messageContent: '',
      to: [],
      cc: [],
      bcc: [],
      toInput: '',
      ccInput: '',
      bccInput: '',
    },
  });

  // Watch all recipient fields
  const toEmails = watch('to');
  const ccEmails = watch('cc');
  const bccEmails = watch('bcc');
  const toInput = watch('toInput');
  const ccInput = watch('ccInput');
  const bccInput = watch('bccInput');

  const filterContacts = (contacts: Sender[], searchTerm: string, excludeEmails: string[]) => {
    if (!searchTerm) return [];
    const term = searchTerm.toLowerCase();
    return contacts.filter(
      (contact) =>
        (contact.email?.toLowerCase().includes(term) ||
          contact.name?.toLowerCase().includes(term)) &&
        !excludeEmails.includes(contact.email),
    );
  };

  const handleAddEmail = (type: 'to' | 'cc' | 'bcc', email: string) => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return;

    const currentEmails = getValues(type);
    if (isValidEmail(trimmedEmail) && !currentEmails.includes(trimmedEmail)) {
      setValue(type, [...currentEmails, trimmedEmail]);
      setValue(`${type}Input`, '');
      composerDispatch({ type: 'SET_UNSAVED_CHANGES', payload: true });
    }
  };

  //   const filteredContacts = React.useMemo(
  //     () => filterContacts(contactsList, toInput, toEmails),
  //     [contactsList, toInput, toEmails],
  //   );

  //   const filteredCcContacts = React.useMemo(
  //     () => filterContacts(contactsList, ccInput, [...toEmails, ...ccEmails]),
  //     [contactsList, ccInput, toEmails, ccEmails],
  //   );

  //   const filteredBccContacts = React.useMemo(
  //     () => filterContacts(contactsList, bccInput, [...toEmails, ...ccEmails, ...bccEmails]),
  //     [contactsList, bccInput, toEmails, ccEmails, bccEmails],
  //   );

  const handleSendEmail = async (values: FormData) => {
    if (!emailData) return;
    try {
      const originalEmail = emailData.latest;
      const userEmail = session?.activeConnection?.email?.toLowerCase();

      if (!userEmail) {
        throw new Error('Active connection email not found');
      }

      if (!originalEmail) {
        throw new Error('Original email not found');
      }

      const subject =
        mode === 'forward'
          ? `Fwd: ${originalEmail.subject || ''}`
          : originalEmail.subject?.startsWith('Re:')
            ? originalEmail.subject
            : `Re: ${originalEmail?.subject || ''}`;

      // Convert email strings to Sender objects
      const toRecipients: Sender[] = toEmails.map((email) => ({
        email,
        name: email.split('@')[0] || 'User',
      }));

      const ccRecipients: Sender[] | undefined = showCc
        ? ccEmails.map((email) => ({
            email,
            name: email.split('@')[0] || 'User',
          }))
        : undefined;

      const bccRecipients: Sender[] | undefined = showBcc
        ? bccEmails.map((email) => ({
            email,
            name: email.split('@')[0] || 'User',
          }))
        : undefined;

      const messageId = originalEmail.messageId;
      const threadId = originalEmail.threadId;
      const formattedMessage = values.messageContent;
      const originalDate = new Date(originalEmail.receivedOn || '').toLocaleString();
      const quotedMessage = originalEmail.decodedBody;

      const replyBody = constructReplyBody(
        formattedMessage,
        originalDate,
        originalEmail.sender,
        toRecipients,
        quotedMessage,
      );

      const inReplyTo = messageId;
      const existingRefs = originalEmail.references?.split(' ') || [];
      const references = [...existingRefs, originalEmail?.inReplyTo, cleanEmailAddress(messageId)]
        .filter(Boolean)
        .join(' ');

      await sendEmail({
        to: toRecipients,
        cc: ccRecipients,
        bcc: bccRecipients,
        subject,
        message: replyBody,
        attachments,
        fromEmail: selectedFromEmail || aliases?.[0]?.email || userEmail,
        headers: {
          'In-Reply-To': inReplyTo ?? '',
          References: references,
          'Thread-Id': threadId ?? '',
        },
        threadId,
      }).then(() => mutate());

      if (ccRecipients && bccRecipients) {
        posthog.capture('Reply Email Sent with CC and BCC');
      } else if (ccRecipients) {
        posthog.capture('Reply Email Sent with CC');
      } else if (bccRecipients) {
        posthog.capture('Reply Email Sent with BCC');
      } else {
        posthog.capture('Reply Email Sent');
      }

      reset();
      setMode(null);
      toast.success(t('pages.createEmail.emailSentSuccessfully'));
    } catch (error) {
      console.error('Error sending email:', error);
      toast.error(t('pages.createEmail.failedToSendEmail'));
    }
  };

  const onSubmit: SubmitHandler<FormData> = async (data) => {
    if (composerState.isLoading) return;
    composerDispatch({ type: 'SET_LOADING', payload: true });
    await handleSendEmail(data).finally(() => {
      composerDispatch({ type: 'SET_LOADING', payload: false });
    });
  };

  const handleAttachment = (files: File[]) => {
    if (files) {
      composerDispatch({ type: 'SET_UPLOADING', payload: true });
      try {
        setAttachments([...attachments, ...files]);
      } finally {
        composerDispatch({ type: 'SET_UPLOADING', payload: false });
      }
    }
  };

  const handleAttachmentEvent = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      composerDispatch({ type: 'SET_UPLOADING', payload: true });
      try {
        setAttachments([...attachments, ...Array.from(e.target.files)]);
      } finally {
        composerDispatch({ type: 'SET_UPLOADING', payload: false });
      }
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(attachments.filter((_, i) => i !== index));
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.target || !(e.target as HTMLElement).closest('.ProseMirror')) {
      e.preventDefault();
      e.stopPropagation();
      composerDispatch({ type: 'SET_DRAGGING', payload: true });
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.target || !(e.target as HTMLElement).closest('.ProseMirror')) {
      e.preventDefault();
      e.stopPropagation();
      composerDispatch({ type: 'SET_DRAGGING', payload: false });
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!e.target || !(e.target as HTMLElement).closest('.ProseMirror')) {
      e.preventDefault();
      e.stopPropagation();
      composerDispatch({ type: 'SET_DRAGGING', payload: false });

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        setAttachments([...attachments, ...Array.from(e.dataTransfer.files)]);
      }
    }
  };

  const isValidEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const CloseButton = ({ onClick }: { onClick: (e: React.MouseEvent) => void }) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-6 w-6"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        composerDispatch({ type: 'SET_EDITOR_FOCUSED', payload: false });
        onClick(e);
      }}
    >
      <X className="h-4 w-4" />
    </Button>
  );

  const toggleComposer = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    // Force blur any focused elements
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setMode(null);
    setIsEditingRecipients(false);
    setShowCc(false);
    setShowBcc(false);
    reset();
  };

  useEffect(() => {
    if (composerIsOpen) {
      // Give the editor time to render before focusing
      const timer = setTimeout(() => {
        // Focus the editor - Novel editor typically has a ProseMirror element
        const editorElement = document.querySelector('.ProseMirror');
        if (editorElement instanceof HTMLElement) {
          editorElement.focus();
        }
      }, 100);

      return () => clearTimeout(timer);
    }
  }, [composerIsOpen]);

  // Add these state variables near the top of your ReplyCompose component
  const [isResizing, setIsResizing] = useState(false);
  const [editorHeight, setEditorHeight] = useState(150); // Default height
  const resizeStartY = useRef(0);
  const startHeight = useRef(0);

  // Update your handleMouseMove function to use these state variables
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isResizing) {
        e.preventDefault();
        const deltaY = resizeStartY.current - e.clientY;
        let newHeight = Math.max(100, Math.min(500, startHeight.current + deltaY));
        setEditorHeight(newHeight);
      }
    },
    [isResizing],
  );

  //   // Add a function to handle starting the resize
  //   const handleResizeStart = (e: React.MouseEvent) => {
  //     setIsResizing(true);
  //     resizeStartY.current = e.clientY;
  //     startHeight.current = editorHeight;
  //   };

  //   // Handle keyboard shortcuts for sending email
  //   const handleKeyDown = (e: React.KeyboardEvent) => {
  //     // Check for Cmd/Ctrl + Enter
  //     if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
  //       e.preventDefault();
  //       if (isFormValid) {
  //         handleSubmit(onSubmit)();
  //       }
  //     }
  //   };

  // Update onChange handler in Editor component
  const handleEditorChange = (content: string) => {
    setValue('messageContent', content);
  };

  // Check if the message is empty
  const isMessageEmpty =
    !getValues('messageContent') ||
    getValues('messageContent') ===
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [],
          },
        ],
      });

  const handleAIButtonClick = async () => {
    if (!emailData) return;
    aiDispatch({ type: 'SET_LOADING', payload: true });
    try {
      // Extract relevant information from the email thread for context
      const latestEmail = emailData.latest;
      if (!latestEmail) return;
      const originalSender = latestEmail?.sender?.name || 'the recipient';

      // Create a summary of the thread content for context
      const threadContent = (
        await Promise.all(
          emailData.messages.map(async (email) => {
            const body = await extractTextFromHTML(email.decodedBody || 'No content');
            return `
            <email>
              <from>${email.sender?.name || 'Unknown'} &lt;${email.sender?.email || 'unknown@email.com'}&gt;</from>
              <subject>${email.subject || 'No Subject'}</subject>
              <date>${new Date(email.receivedOn || '').toLocaleString()}</date>
              <body>${body}</body>
            </email>`;
          }),
        )
      ).join('\n\n');

      const suggestion = await generateAIResponse(threadContent, originalSender);
      aiDispatch({ type: 'SET_SUGGESTION', payload: suggestion });
      composerDispatch({
        type: 'SET_EDITOR_INITIAL_VALUE',
        payload: createAIJsonContent(suggestion),
      });
      composerDispatch({ type: 'INCREMENT_EDITOR_KEY' });
      aiDispatch({ type: 'SET_SHOW_OPTIONS', payload: true });

      // Add this: Focus the editor after AI content is set
      setTimeout(() => {
        const editorElement = document.querySelector('.ProseMirror');
        if (editorElement instanceof HTMLElement) {
          editorElement.focus();
        }
      }, 100); // Small delay to ensure content is rendered
    } catch (error: any) {
      console.error('Error generating AI response:', error);

      let errorMessage = 'Failed to generate AI response. Please try again or compose manually.';

      if (error.message) {
        if (error.message.includes('Groq API')) {
          errorMessage = 'AI service is currently unavailable. Please try again later.';
        } else if (error.message.includes('key is not configured')) {
          errorMessage = 'AI service is not properly configured. Please contact support.';
        }
      }

      toast.error(errorMessage);
    } finally {
      aiDispatch({ type: 'SET_LOADING', payload: false });
    }
  };

  const acceptAISuggestion = () => {
    if (aiState.suggestion) {
      const jsonContent = createAIJsonContent(aiState.suggestion);
      const htmlContent = convertJSONToHTML(jsonContent);

      setValue('messageContent', htmlContent);

      composerDispatch({ type: 'SET_EDITOR_INITIAL_VALUE', payload: undefined });
      aiDispatch({ type: 'RESET' });
    }
  };

  const rejectAISuggestion = () => {
    composerDispatch({ type: 'SET_EDITOR_INITIAL_VALUE', payload: undefined });
    composerDispatch({ type: 'INCREMENT_EDITOR_KEY' });
    aiDispatch({ type: 'RESET' });
  };

  // Create a ref for the send button
  const sendButtonRef = useRef<HTMLButtonElement>(null);

  // Update the Editor's onCommandEnter prop
  const handleCommandEnter = () => {
    // Programmatically click the send button
    sendButtonRef.current?.click();
  };

  // Add a handler for tab key acceptance
  const handleTabAccept = useCallback(() => {
    if (aiState.showOptions && aiState.suggestion) {
      acceptAISuggestion();
      return true; // Return true to indicate we handled the tab
    }
    return false; // Return false to allow normal tab behavior
  }, [aiState.showOptions, aiState.suggestion]);

  // Helper function to initialize recipients based on mode
  const initializeRecipients = useCallback(() => {
    if (!emailData || !emailData.messages || emailData.messages.length === 0)
      return { to: [], cc: [] };

    const latestMessage = emailData.messages[0];
    if (!latestMessage) return { to: [], cc: [] };

    // Get the active connection's email
    const activeConnectionEmail = session?.activeConnection?.email?.toLowerCase();
    const userEmail = activeConnectionEmail;

    const to: string[] = [];
    const cc: string[] = [];

    if (mode === 'forward') {
      return { to: [], cc: [] };
    }

    if (mode === 'reply') {
      // For individual replies, check if the sender is from our active connection
      const senderEmail = latestMessage.sender?.email?.toLowerCase();
      const replyEmail = latestMessage.replyTo || senderEmail;

      // If we're replying from the same email as the sender, use the original recipients
      if (senderEmail === userEmail && latestMessage.to && latestMessage.to.length > 0) {
        // Get the first recipient that isn't us
        const firstRecipient = latestMessage.to.find(
          (recipient) => recipient.email?.toLowerCase() !== userEmail,
        );
        if (firstRecipient?.email) {
          to.push(firstRecipient.email);
        }
      } else if (replyEmail) {
        // Otherwise reply to the sender
        to.push(replyEmail);
      }
    } else if (mode === 'replyAll') {
      const senderEmail = latestMessage.sender?.email?.toLowerCase();

      // Add original sender to To if not current user
      if (senderEmail && senderEmail !== userEmail) {
        to.push(latestMessage.sender.email);
      }

      // Add original To recipients (except current user and sender)
      if (latestMessage.to) {
        latestMessage.to.forEach((recipient) => {
          if (
            recipient.email &&
            recipient.email.toLowerCase() !== userEmail &&
            recipient.email.toLowerCase() !== senderEmail &&
            !to.includes(recipient.email)
          ) {
            to.push(recipient.email);
          }
        });
      }

      // Add CC recipients (except current user and those already in To)
      if (latestMessage.cc) {
        latestMessage.cc.forEach((recipient) => {
          if (
            recipient.email &&
            recipient.email.toLowerCase() !== userEmail &&
            !to.includes(recipient.email) &&
            !cc.includes(recipient.email)
          ) {
            cc.push(recipient.email);
          }
        });
      }

      // If there are CC recipients, show the CC field
      if (cc.length > 0) {
        setShowCc(true);
      }
    }

    return { to, cc };
  }, [emailData, mode, session?.activeConnection?.email]);

  // Initialize recipients when composer opens
  useEffect(() => {
    if (composerIsOpen) {
      const { to, cc } = initializeRecipients();
      setValue('to', to);
      setValue('cc', cc);
    }
  }, [composerIsOpen, initializeRecipients, setValue]);

  // Modify renderHeaderContent to show recipient fields
  const renderHeaderContent = () => {
    if (!emailData) return null;

    const latestEmail = emailData.latest;
    if (!latestEmail) return null;

    const icon =
      mode === 'forward' ? (
        <Forward className="h-4 w-4" />
      ) : mode === 'replyAll' ? (
        <ReplyAll className="h-4 w-4" />
      ) : (
        <Reply className="h-4 w-4" />
      );

    if (isEditingRecipients || mode === 'forward') {
      return (
        <div className="ml-1.5 flex-1 space-y-2">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {icon}
              <span className="text-sm font-medium">
                {mode === 'forward' ? 'Forward' : 'Recipients'}
              </span>
            </div>
          </div>

          <EmailInput
            type="to"
            emails={toEmails}
            setEmails={(emails) => setValue('to', emails)}
            inputValue={toInput}
            setInputValue={(value) => setValue('toInput', value)}
            filteredContacts={[]}
            isLoading={composerState.isLoading}
            onAddEmail={handleAddEmail}
            hasUnsavedChanges={composerState.hasUnsavedChanges}
            setHasUnsavedChanges={(value) =>
              composerDispatch({ type: 'SET_UNSAVED_CHANGES', payload: value })
            }
          />

          <div className="flex items-center">
            <div className="text-muted-foreground mr-1 w-[35px] text-right text-xs">From:</div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-auto justify-between p-0 text-left text-sm font-normal"
                >
                  <span>
                    {selectedFromEmail || aliases?.[0]?.email || session?.activeConnection?.email}
                  </span>
                  <ChevronDown className="ml-1 h-3 w-3 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {isLoadingAliases ? (
                  <div className="px-2 py-1 text-center text-sm">Loading...</div>
                ) : aliases && aliases.length > 0 ? (
                  aliases.map((alias) => (
                    <DropdownMenuItem
                      key={alias.email}
                      onClick={() => setSelectedFromEmail(alias.email)}
                      className="cursor-pointer"
                    >
                      {alias.name ? `${alias.name} <${alias.email}>` : alias.email}
                      {alias.primary && ' (Primary)'}
                    </DropdownMenuItem>
                  ))
                ) : (
                  <div className="px-2 py-1 text-center text-sm">
                    {session?.activeConnection?.email}
                  </div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {showCc && (
            <EmailInput
              type="cc"
              emails={ccEmails}
              setEmails={(emails) => setValue('cc', emails)}
              inputValue={ccInput}
              setInputValue={(value) => setValue('ccInput', value)}
              filteredContacts={[]}
              isLoading={composerState.isLoading}
              onAddEmail={handleAddEmail}
              hasUnsavedChanges={composerState.hasUnsavedChanges}
              setHasUnsavedChanges={(value) =>
                composerDispatch({ type: 'SET_UNSAVED_CHANGES', payload: value })
              }
            />
          )}

          {showBcc && (
            <EmailInput
              type="bcc"
              emails={bccEmails}
              setEmails={(emails) => setValue('bcc', emails)}
              inputValue={bccInput}
              setInputValue={(value) => setValue('bccInput', value)}
              filteredContacts={[]}
              isLoading={composerState.isLoading}
              onAddEmail={handleAddEmail}
              hasUnsavedChanges={composerState.hasUnsavedChanges}
              setHasUnsavedChanges={(value) =>
                composerDispatch({ type: 'SET_UNSAVED_CHANGES', payload: value })
              }
            />
          )}
        </div>
      );
    }

    // Show compact view with all recipients
    const allRecipients = [...toEmails, ...(showCc ? ccEmails : []), ...(showBcc ? bccEmails : [])];
    const recipientDisplay = allRecipients.join(', ');

    return (
      <div className="flex w-full flex-col gap-1">
        <div
          className="hover:bg-accent/50 flex cursor-pointer items-center gap-2 rounded px-2 py-1"
          onClick={() => setIsEditingRecipients(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              setIsEditingRecipients(true);
            }
          }}
        >
          {icon}
          <span className="text-muted-foreground mr-1 text-xs">To:</span>
          <p className="truncate text-sm" title={recipientDisplay}>
            {recipientDisplay || t('common.mailDisplay.to')}
          </p>
        </div>
        <div className="flex items-center">
          <span className="text-muted-foreground mr-1 w-[35px] text-right text-xs">From:</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="h-auto justify-between p-0 text-left text-sm font-normal"
              >
                <span>
                  {selectedFromEmail || aliases?.[0]?.email || session?.activeConnection?.email}
                </span>
                <ChevronDown className="ml-1 h-3 w-3 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {isLoadingAliases ? (
                <div className="px-2 py-1 text-center text-sm">Loading...</div>
              ) : aliases && aliases.length > 0 ? (
                aliases.map((alias) => (
                  <DropdownMenuItem
                    key={alias.email}
                    onClick={() => setSelectedFromEmail(alias.email)}
                    className="cursor-pointer"
                  >
                    {alias.name ? `${alias.name} <${alias.email}>` : alias.email}
                    {alias.primary && ' (Primary)'}
                  </DropdownMenuItem>
                ))
              ) : (
                <div className="px-2 py-1 text-center text-sm">
                  {session?.activeConnection?.email}
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  // Add this effect near other useEffects
  useEffect(() => {
    if (!composerIsOpen) {
      // Reset form state
      reset();
      // Reset attachments
      setAttachments([]);
      // Reset AI state
      aiDispatch({ type: 'RESET' });
      // Reset editor key to force a fresh instance
      composerDispatch({ type: 'INCREMENT_EDITOR_KEY' });
    }
  }, [composerIsOpen, reset, mode]);

  // Update saveDraft function
  const saveDraft = useCallback(async () => {
    if (!emailData || !emailData.latest) return;
    if (!getValues('messageContent')) return;

    try {
      composerDispatch({ type: 'SET_LOADING', payload: true });
      const originalEmail = emailData.latest;
      const draftData = {
        to: mode === 'forward' ? getValues('to').join(', ') : originalEmail.sender.email,
        subject: originalEmail.subject?.startsWith(mode === 'forward' ? 'Fwd: ' : 'Re: ')
          ? originalEmail.subject
          : `${mode === 'forward' ? 'Fwd: ' : 'Re: '}${originalEmail.subject || ''}`,
        message: getValues('messageContent'),
        attachments: attachments,
        id: draftId,
      };

      const response = await createDraft(draftData);

      if (response?.id && response.id !== draftId) {
        setDraftId(response.id);
      }

      toast.success('Draft saved');
    } catch (error) {
      console.error('Error saving draft:', error);
      toast.error('Failed to save draft');
    } finally {
      composerDispatch({ type: 'SET_LOADING', payload: false });
    }
  }, [mode, emailData, getValues, attachments, draftId, setDraftId]);

  useEffect(() => {
    if (composerIsOpen) {
      console.log('Enabling compose scope (ReplyCompose)');
      enableScope('compose');
    } else {
      console.log('Disabling compose scope (ReplyCompose)');
      disableScope('compose');
    }

    return () => {
      console.log('Cleaning up compose scope (ReplyCompose)');
      disableScope('compose');
    };
  }, [composerIsOpen, enableScope, disableScope]);

  // Simplified composer visibility check
  if (!composerIsOpen) {
    if (!emailData || emailData.messages.length === 0) return null;

    // Get the latest email in the thread
    const latestEmail = emailData.latest;
    if (!latestEmail) return null;

    // Get all unique participants (excluding current user)
    const userEmail = session?.activeConnection?.email?.toLowerCase();
    const allParticipants = new Set<string>();

    // Add recipients from 'to' field
    latestEmail.to.forEach((recipient) => {
      if (recipient.email.toLowerCase() !== userEmail) {
        allParticipants.add(recipient.email.toLowerCase());
      }
    });

    // Add recipients from 'cc' field if exists
    if (latestEmail.cc) {
      latestEmail.cc.forEach((recipient) => {
        if (recipient.email.toLowerCase() !== userEmail) {
          allParticipants.add(recipient.email.toLowerCase());
        }
      });
    }

    // Add sender if not current user
    if (latestEmail.sender.email.toLowerCase() !== userEmail) {
      allParticipants.add(latestEmail.sender.email.toLowerCase());
    }

    // Show Reply All only if there are more than one participant (excluding current user)
    const showReplyAll = allParticipants.size > 1;

    return (
      <div className="bg-offsetLight dark:bg-offsetDark flex w-full gap-2 px-2">
        <Button
          onClick={() => {
            setMode('reply');
          }}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-md"
          variant="outline"
        >
          <Reply className="h-4 w-4" />
          <span>{t('common.threadDisplay.reply')}</span>
        </Button>
        {showReplyAll && (
          <Button
            onClick={() => {
              setMode('replyAll');
            }}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-md"
            variant="outline"
          >
            <ReplyAll className="h-4 w-4" />
            <span>{t('common.threadDisplay.replyAll')}</span>
          </Button>
        )}
        <Button
          onClick={() => {
            setMode('forward');
          }}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-md"
          variant="outline"
        >
          <Forward className="h-4 w-4" />
          <span>{t('common.threadDisplay.forward')}</span>
        </Button>
      </div>
    );
  }
  if (!emailData) return null;
  return (
    <div className="bg-offsetLight dark:bg-offsetDark w-full px-2">
      <form
        ref={composerRef}
        className={cn(
          'border-border ring-offset-background relative z-20 flex flex-col rounded-[10px] border px-2 py-2 transition-all duration-300 ease-in-out',
          composerState.isEditorFocused ? 'ring-2 ring-[#3D3D3D] ring-offset-1' : '',
        )}
        style={{
          minHeight: '150px',
          maxHeight: '800px',
          overflow: 'hidden',
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onSubmit={handleSubmit(onSubmit)}
        // onKeyDown={handleKeyDown}
      >
        {/* Drag overlay */}
        {composerState.isDragging && <DragOverlay />}

        {/* Header */}
        <div className="text-muted-foreground mb-2 flex flex-shrink-0 items-start justify-between text-sm">
          <div className="flex-1">{renderHeaderContent()}</div>
          <div className="flex shrink-0 items-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              tabIndex={-1}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setShowCc(!showCc);
                if (showCc) {
                  setValue('cc', []);
                }
                setIsEditingRecipients(true);
                setTimeout(() => {
                  ccInputRef.current?.focus();
                }, 0);
              }}
              className="text-xs"
            >
              <span>Cc</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              tabIndex={-1}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setShowBcc(!showBcc);
                if (showBcc) {
                  setValue('bcc', []);
                }
                setIsEditingRecipients(true);
                setTimeout(() => {
                  bccInputRef.current?.focus();
                }, 0);
              }}
              className="text-xs"
            >
              <span>Bcc</span>
            </Button>
            <CloseButton onClick={toggleComposer} />
          </div>
        </div>

        {/* Editor container with fixed menu and growing content */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="w-full overflow-auto">
            <Editor
              onAttachmentsChange={handleAttachment}
              key={composerState.editorKey}
              onChange={handleEditorChange}
              initialValue={composerState.editorInitialValue}
              onCommandEnter={handleCommandEnter}
              onTab={handleTabAccept}
              className={cn(
                'max-w-[600px] md:max-w-[100vw]',
                aiState.showOptions
                  ? 'rounded-md border border-dotted border-blue-200 bg-blue-50/30 p-1 dark:border-blue-800 dark:bg-blue-950/30'
                  : 'border border-transparent p-1',
                composerState.isLoading ? 'cursor-not-allowed opacity-50' : '',
              )}
              placeholder={
                aiState.showOptions
                  ? 'AI-generated reply (you can edit)'
                  : 'Type your reply here...'
              }
              onFocus={() => {
                composerDispatch({ type: 'SET_EDITOR_FOCUSED', payload: true });
              }}
              onBlur={() => {
                composerDispatch({ type: 'SET_EDITOR_FOCUSED', payload: false });
              }}
              myInfo={{
                name: session?.user.name,
                email: session?.user.email,
              }}
              senderInfo={{
                name: emailData.latest?.sender?.name,
                email: emailData.latest?.sender?.email,
              }}
            />
          </div>
        </div>

        {aiState.showOptions && (
          <div className="text-muted-foreground ml-2 mt-1 flex-shrink-0 text-xs">
            Press <kbd className="bg-muted rounded px-1 py-0.5">Tab</kbd> to accept
          </div>
        )}

        <div className="mt-auto flex flex-shrink-0 items-center justify-between">
          <div className="flex items-center gap-2">
            {!aiState.showOptions ? (
              <Button
                variant="outline"
                className="group relative w-40 overflow-hidden transition-all duration-200"
                onClick={(e) => {
                  e.preventDefault();
                  void handleAIButtonClick();
                }}
                disabled={aiState.isLoading}
              >
                {aiState.isLoading ? (
                  <div className="absolute left-[9px] h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600"></div>
                ) : (
                  <Sparkles className="absolute left-[9px] h-6 w-6" />
                )}
                <span className="whitespace-nowrap pl-5">
                  {aiState.isLoading ? 'Generating...' : 'Generate Email'}
                </span>
              </Button>
            ) : (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  className="h-9 w-20 border bg-black px-12 text-white hover:bg-transparent dark:bg-white dark:text-black"
                  onClick={(e) => {
                    e.preventDefault();
                    acceptAISuggestion();
                  }}
                >
                  <Check className="h-5 w-5" />
                  Accept
                </Button>
                <Button
                  variant="ghost"
                  className="w-20 text-black/50 hover:bg-transparent dark:text-white/50"
                  onClick={(e) => {
                    e.preventDefault();
                    rejectAISuggestion();
                  }}
                >
                  <XIcon className="h-5 w-5" />
                  Reject
                </Button>
              </div>
            )}
            {/* Conditionally render the Popover only if attachments exist */}
            {attachments.length > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="flex items-center gap-2">
                    <Paperclip className="h-4 w-4" />
                    <span>
                      {attachments.length}{' '}
                      {t('common.replyCompose.attachmentCount', { count: attachments.length })}
                    </span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 touch-auto" align="start">
                  <div className="space-y-2">
                    <div className="px-1">
                      <h4 className="font-medium leading-none">
                        {t('common.replyCompose.attachments')}
                      </h4>
                      <p className="text-muted-foreground text-sm">
                        {attachments.length}{' '}
                        {t('common.replyCompose.fileCount', { count: attachments.length })}
                      </p>
                    </div>
                    <Separator />
                    <div className="h-[300px] touch-auto overflow-y-auto overscroll-contain px-1 py-1">
                      <div className="grid grid-cols-2 gap-2">
                        {attachments.map((file, index) => (
                          <div
                            key={index}
                            className="group relative overflow-hidden rounded-md border"
                          >
                            <UploadedFileIcon
                              removeAttachment={removeAttachment}
                              index={index}
                              file={file}
                            />
                            <div className="bg-muted/10 p-2">
                              <p className="text-xs font-medium">
                                {truncateFileName(file.name, 20)}
                              </p>
                              <p className="text-muted-foreground text-xs">
                                {(file.size / (1024 * 1024)).toFixed(2)} MB
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            {/* The Plus button is always visible, wrapped in a label for better click handling */}
            <div className="-pb-1.5 relative">
              <Input
                type="file"
                id="reply-attachment-input"
                className="absolute h-full w-full cursor-pointer opacity-0"
                onChange={handleAttachmentEvent}
                multiple
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
              />
              <Button
                variant="ghost"
                className="hover:bg-muted -ml-1 h-8 w-8 cursor-pointer rounded-full transition-transform"
                tabIndex={-1}
              >
                <Plus className="h-4 w-4 cursor-pointer" />
              </Button>
            </div>
          </div>
          <div className="mr-2 flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              disabled={composerState.isLoading || !getValues('messageContent')}
              onClick={(e) => {
                e.preventDefault();
                void saveDraft();
              }}
            >
              {t('common.replyCompose.saveDraft')}
            </Button>
            <Button
              ref={sendButtonRef}
              size="sm"
              className={cn(
                'relative h-8 w-8 rounded-full',
                composerState.isLoading && 'cursor-not-allowed',
              )}
              onClick={handleSubmit(onSubmit)}
              disabled={composerState.isLoading}
              type="button"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
