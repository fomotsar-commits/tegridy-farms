import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center px-6">
          <div className="text-center max-w-sm">
            <h2 className="heading-luxury text-2xl text-white mb-2">Something went wrong</h2>
            <p className="text-white/40 text-[13px] mb-6">Something went wrong. Please refresh.</p>
            <button
              onClick={() => window.location.reload()}
              className="btn-primary px-7 py-2.5 text-[14px]"
            >
              Refresh Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
