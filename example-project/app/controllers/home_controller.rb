# frozen_string_literal: true

class HomeController < ApplicationController
  def index
    render layout: "marketing"
  end

  def privacy_policy; end

  def terms_of_service; end
end
