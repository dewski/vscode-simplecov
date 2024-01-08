# frozen_string_literal: true

class EmbedsController < ApplicationController
  layout "embeds"

  before_action :set_iframe_headers

  content_security_policy do |policy|
    policy.default_src(lambda do
      if authorized_referer?
        "'self' #{referer_site}"
      else
        "'self'"
      end
    end)

    policy.frame_ancestors(lambda do
      if authorized_referer?
        "'self' #{referer_site}"
      else
        "'self'"
      end
    end)

    policy.script_src(lambda do
      if authorized_referer?
        "'self' #{referer_site}"
      else
        "'self'"
      end
    end)

    policy.style_src(lambda do
      if authorized_referer?
        "'self' #{referer_site}"
      else
        "'self'"
      end
    end)

    policy.report_uri "/csp-violation-report-endpoint"
  end

  protected

  helper_method def url
    params[:url].presence
  end

  helper_method def url?
    url.present?
  end

  # Determines if the request is coming from a Shopify retailer.
  helper_method def authorized_referer?
    return false unless current_retailer?

    current_retailer.customer?
  end

  helper_method def referer_site
    return unless (referer = request.referer)

    uri = Addressable::URI.parse(referer)
    uri.normalized_site
  rescue Addressable::URI::InvalidURIError
    nil
  end

  def current_user=(user)
    if user.present?
      cookies.permanent.signed[:user_id] = {
        value: user.id,
        secure: Rails.env.production? || request.ssl?,
        domain: :all,
        httponly: true,
      }
    else
      cookies.delete(:user_id, domain: :all, secure: Rails.env.production? || request.ssl?)
    end
  end

  helper_method def current_user
    @current_user ||= if (user_id = cookies.signed[:user_id])
      User.find_by(id: user_id)
    end
  end

  helper_method def current_user?
    current_user.present?
  end

  helper_method def user_signed_in?
    current_user.present?
  end

  def authenticate_user!
    return if user_signed_in?

    if url?
      redirect_to new_embeds_inventory_subscription_path(url: url)
    else
      render_404
    end
  end

  helper_method def current_product
    return @current_product if defined?(@current_product)

    @current_product = if current_inventory_subscription?
      current_inventory_subscription.product
    elsif url?
      Product.find_by(url: url)
    end
  end

  attr_writer :current_product

  helper_method def current_product?
    current_product.present?
  end

  def require_current_product
    return if current_product?

    render_404
  end

  helper_method def current_retailer
    @current_retailer ||= current_product&.retailer
  end

  helper_method def current_retailer?
    current_retailer.present?
  end

  helper_method def current_inventory_subscription
    return @current_inventory_subscription if defined?(@current_inventory_subscription)

    @current_inventory_subscription = if user_signed_in?
      if (inventory_subscription_id = params[:inventory_subscription_id])
        current_user.inventory_subscriptions.find_by(id: inventory_subscription_id)
      elsif (id = params[:id])
        current_user.inventory_subscriptions.find_by(id: id)
      elsif url? && (product = Product.find_by(url: url))
        current_user.inventory_subscriptions.find_by(product: product)
      end
    end
  end

  helper_method def current_inventory_subscription?
    current_inventory_subscription.present?
  end

  def require_current_inventory_subscription
    return if current_inventory_subscription?

    if url?
      redirect_to new_embeds_inventory_subscription_path(url: url)
    else
      render_404
    end
  end

  helper_method def shopify_retailer?
    current_retailer&.shopify_shop.present?
  end

  private

  def set_iframe_headers
    response.set_header("P3P", 'CP="Not used"')
    response.headers.except!("X-Frame-Options")
  end
end
