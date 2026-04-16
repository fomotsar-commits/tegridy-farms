import { Component, type ReactNode, type ErrorInfo } from 'react';
import { reportError } from '../../lib/errorReporting';

interface Props {
  children: ReactNode;
  fallback?: ReactNode | ((reset: () => void) => ReactNode);
  resetKeys?: unknown[];
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

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && this.props.resetKeys) {
      const prevKeys = prevProps.resetKeys ?? [];
      const currKeys = this.props.resetKeys;
      const changed = currKeys.length !== prevKeys.length ||
        currKeys.some((key, i) => key !== prevKeys[i]);
      if (changed) {
        this.setState({ hasError: false });
      }
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    try {
      reportError(error, errorInfo.componentStack ?? undefined);
    } catch (reportingError) {
      console.error('Failed to report error:', reportingError);
    }
  }

  resetErrorBoundary = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        if (typeof this.props.fallback === 'function') {
          return this.props.fallback(this.resetErrorBoundary);
        }
        return this.props.fallback;
      }
      return (
        <div className="min-h-[200px] flex items-center justify-center px-6">
          <div className="text-center max-w-sm">
            <h2 className="heading-luxury text-2xl text-white mb-2">Something went wrong</h2>
            <p className="text-white text-[13px] mb-6">An unexpected error occurred. Please refresh the page to continue.</p>
            <button
              type="button"
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
