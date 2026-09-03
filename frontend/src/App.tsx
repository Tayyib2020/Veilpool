import PhotographyLanding from "./PhotographyLanding";
import LoadingPreview from "./LoadingPreview";
import OperatorPanel from "./OperatorPanel";
import UserApp from "./UserApp";
import LandingScaleFrame from "./LandingScaleFrame";

export default function App() {
  if (window.location.pathname === "/loading-preview") return <LoadingPreview />;
  if (window.location.pathname === "/operator") return <OperatorPanel />;
  return window.location.pathname === "/app" ? <UserApp /> : <LandingScaleFrame><PhotographyLanding /></LandingScaleFrame>;
}
