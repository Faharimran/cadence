-- Why an outbound message failed, in words the business can act on. Nullable:
-- every message that already succeeded has no reason to carry one.
ALTER TABLE "ConversationMessage" ADD COLUMN "failureReason" TEXT;
