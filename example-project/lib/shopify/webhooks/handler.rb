# frozen_string_literal: true

module Shopify
  module Webhooks
    class Handler
      extend ShopifyAPI::Webhooks::Handler

      # The Shopify::Shop record for the shop that sent the webhook.
      attr_reader :shop

      # The topic of the webhook. See https://help.shopify.com/en/api/reference/events/webhook#events.
      attr_reader :topic

      # The params of the webhook.
      attr_reader :params

      def self.handle(topic:, shop:, body:)
        ActiveSupport::Notifications.instrument("handle.shopify_webhooks", topic: topic, shop: shop, handler: self, body: body) do
          shopify_shop = Shopify::Shop.find_by!(shopify_domain: shop)
          params = ActionController::Parameters.new(body)
          attributes = params.permit(permitted_attributes)

          handler = new(
            shop: shopify_shop,
            topic: topic,
            params: Shopify::Mash.new(attributes.to_h),
          )

          handler.handle
        end
      rescue ActiveRecord::RecordNotFound
        IsInStock.stats.increment("webhooks.handler.not_found", tags: ["topic:#{topic}", "shop:#{shop}"])
      rescue ActiveRecord::RecordInvalid => e
        # This is a stale update, we can safely ignore the invalid record.
        if e.record.errors.of_kind?(:shopify_updated_at, :stale)
          IsInStock.stats.increment("webhooks.handler.stale", tags: ["topic:#{topic}", "shop:#{shop}"])
        else
          raise
        end
      end

      def self.permitted_attributes
        %i[id created_at updated_at]
      end

      def initialize(shop:, topic:, params:)
        @shop = shop
        @topic = topic
        @params = params
      end

      def handle
        puts "Received webhook! topic: #{topic} shop: #{shop} body: #{body}"
      end
    end
  end
end
