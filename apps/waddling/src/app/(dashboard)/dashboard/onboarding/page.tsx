import { ConnectWizard } from '@/components/onboarding/connect-wizard';

// Guided "aha" onboarding — connect → install MCP → first governed query, one concept
// at a time. Non-blocking (the paywall is the gate, not this); resumable from backend
// state. The whole flow lives in the client wizard.
export default function OnboardingPage() {
  return <ConnectWizard />;
}
