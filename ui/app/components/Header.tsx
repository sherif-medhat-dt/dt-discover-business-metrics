import React from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "@dynatrace/strato-components-preview/layouts";

export const Header = () => {
  return (
    <AppHeader>
      <AppHeader.NavItems>
        <AppHeader.AppNavLink as={Link} to="/" />
        <AppHeader.NavItem as={Link} to="/discovery">
          Discover Metrics
        </AppHeader.NavItem>
        <AppHeader.NavItem as={Link} to="/sessions">
          Business Events
        </AppHeader.NavItem>
        <AppHeader.NavItem as={Link} to="/request-attributes">
          Request Attributes
        </AppHeader.NavItem>
        <AppHeader.NavItem as={Link} to="/wizard">
          Journey Dashboard Wizard
        </AppHeader.NavItem>
      </AppHeader.NavItems>
    </AppHeader>
  );
};
