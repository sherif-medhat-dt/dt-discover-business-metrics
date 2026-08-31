import { Page } from "@dynatrace/strato-components-preview/layouts";
import React from "react";
import { Route, Routes } from "react-router-dom";
import { JourneyWizard } from "./pages/JourneyWizard";
import { Discovery } from "./pages/Discovery";
import { OpenSessions } from "./pages/OpenSessions";
import { RequestAttributes } from "./pages/RequestAttributes";
import { Header } from "./components/Header";
import { Home } from "./pages/Home";

export const App = () => {
  return (
    <Page>
      <Page.Header>
        <Header />
      </Page.Header>
      <Page.Main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/discovery" element={<Discovery />} />
          <Route path="/sessions" element={<OpenSessions />} />
          <Route path="/request-attributes" element={<RequestAttributes />} />
          <Route path="/wizard" element={<JourneyWizard />} />
        </Routes>
      </Page.Main>
    </Page>
  );
};
